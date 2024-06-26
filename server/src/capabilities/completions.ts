import type { CompletionItem, CompletionList } from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import { handleImports, handleRequires } from "../lib/imports-handler";
import { calculateKeyValue, calculateStartOffset, parse } from "../lib/parser";
import ServerState from "../lib/server-state";
import type { UserConfiguration } from "../lib/settings";
import StateManager from "../lib/state-manager";
import { StringAsBytes } from "../lib/string-bytes";
import { dashify } from "../lib/stylex-utils";
import { States, walk } from "../lib/walk";
import type { Connection } from "../server";

type CompletionParams = Parameters<Parameters<Connection["onCompletion"]>[0]>;

async function onCompletion({
  params,
  token,
  serverState,
  settings,
  textDocument,
  languageId,
  parserInit,
  byteRepresentation,
}: {
  params: CompletionParams[0];
  token: CompletionParams[1];
  serverState: ServerState;
  textDocument: TextDocument;
  settings: UserConfiguration;
  languageId: string;
  parserInit: typeof import("@swc/wasm-web/wasm-web.js");
  byteRepresentation: StringAsBytes;
}): Promise<CompletionList | null> {
  const text = textDocument.getText();

  if (!settings.suggestions) return null;

  let parseResult;
  try {
    if (serverState.parserCache.has(textDocument.uri)) {
      parseResult = serverState.parserCache.get(textDocument.uri)!;
    } else {
      parseResult = await parse({
        source: text,
        languageId,
        parser: parserInit,
        token,
      });
      serverState.parserCache.set(textDocument.uri, parseResult);
    }
  } catch (e) {
    console.log(e);
    return null;
  }

  let completions: CompletionItem[] = [];
  let itemDefaults: CompletionList["itemDefaults"];
  const stateManager = new StateManager();
  let moduleStart = 0;

  // Precalculate the byte offset of the parameter
  const paramByte = byteRepresentation.charIndexToByteOffset(
    textDocument.offsetAt(params.position),
  );

  await walk<{
    propertyName: string | undefined;
    callInside: string | null | undefined;
    propertyDeep: number;
  }>(
    parseResult,
    {
      Module(node) {
        moduleStart = node.span.start - calculateStartOffset(textDocument);
      },

      ImportDeclaration(node) {
        handleImports(node, stateManager, settings);

        return false;
      },

      VariableDeclarator(node) {
        handleRequires(node, stateManager, settings);
      },

      "*"(node) {
        if (
          "span" in node &&
          node.type !== "VariableDeclaration" &&
          paramByte < node.span.start - moduleStart &&
          paramByte > node.span.end - moduleStart
        ) {
          return false;
        }
      },

      WithStatement() {
        return false;
      },

      CallExpression(node, state) {
        let verifiedImport: string | undefined;

        if (
          (node.callee.type === "MemberExpression" &&
            node.callee.object.type === "Identifier" &&
            stateManager.verifyStylexIdentifier(node.callee.object.value) &&
            node.callee.property.type === "Identifier" &&
            (verifiedImport = node.callee.property.value)) ||
          (node.callee.type === "Identifier" &&
            [
              "create",
              "createTheme",
              "defineVars",
              "keyframes",
              "firstThatWorks",
            ].includes(
              (verifiedImport = stateManager.verifyNamedImport(
                node.callee.value,
              )) || "",
            ) &&
            verifiedImport)
        ) {
          if (verifiedImport === "create" || verifiedImport === "keyframes") {
            return {
              ...state,
              callInside: verifiedImport,
              propertyDeep: 1,
            };
          } else if (
            verifiedImport === "createTheme" ||
            verifiedImport === "defineVars"
          ) {
            return {
              state: {
                ...state,
                callInside: verifiedImport,
                propertyDeep: 1,
              },
              ignore: [
                verifiedImport === "createTheme" ? "arguments.0" : "",
                "callee",
              ],
            };
          } else if (verifiedImport === "firstThatWorks") {
            return;
          }
        }

        return {
          ...state,
          callInside: null,
        };
      },

      KeyValueProperty(node, state) {
        if (state && state.callInside) {
          if (
            (state.callInside === "create" ||
              state.callInside === "keyframes") &&
            state.propertyDeep === 2
          ) {
            return {
              ...state,
              propertyName: calculateKeyValue(node, stateManager),
              propertyDeep: 3,
            };
          } else if (
            state.callInside === "createTheme" ||
            state.callInside === "defineVars"
          ) {
            if (node.value.type === "ObjectExpression") {
              state.propertyDeep += 1;
            }
            return {
              ...state,
              propertyName: ServerState.STYLEX_CUSTOM_PROPERTY,
            };
          } else {
            return {
              ...state,
              propertyDeep: state.propertyDeep + 1,
            };
          }
        }
      },

      StringLiteral(node, state) {
        if (state && state.callInside && state.propertyName !== "content") {
          const startSpanRelative = textDocument.positionAt(
            byteRepresentation.byteOffsetToCharIndex(
              node.span.start - moduleStart,
            ),
          );

          if (
            paramByte < node.span.start - moduleStart ||
            paramByte > node.span.end - moduleStart
          ) {
            return false;
          }

          const doc = serverState.virtualDocumentFactory.createVirtualDocument(
            dashify(state.propertyName || "--custom"),
            node.value,
          );

          const relativePosition = doc.positionAt(
            serverState.virtualDocumentFactory.mapOffsetToVirtualOffset(
              doc,
              params.position.character - startSpanRelative.character,
            ),
          );

          const cssCompletions = serverState.cssLanguageService!.doComplete(
            doc,
            relativePosition,
            serverState.cssLanguageService!.parseStylesheet(doc),
            {
              completePropertyWithSemicolon: false,
              triggerPropertyValueCompletion: true,
            },
          );

          completions = cssCompletions.items.map((item) => {
            const newTextEdit = item;
            if (newTextEdit.textEdit) {
              if ("range" in newTextEdit.textEdit) {
                newTextEdit.textEdit.range.start.line +=
                  params.position.line - relativePosition.line;
                newTextEdit.textEdit.range.end.line +=
                  params.position.line - relativePosition.line;
                newTextEdit.textEdit.range.start.character +=
                  params.position.character - relativePosition.character;
                newTextEdit.textEdit.range.end.character +=
                  params.position.character - relativePosition.character;
              } else {
                console.log(
                  "[WARN] Mapping InsertReplaceEdit is not supported yet.",
                );
                delete newTextEdit.textEdit;
              }
            }
            return newTextEdit;
          });

          // TODO: Preprocess itemDefaults
          itemDefaults = cssCompletions.itemDefaults;

          console.log("Found completions", completions);

          return States.EXIT;
        }
      },
    },
    token,
    { propertyName: undefined, propertyDeep: 0, callInside: undefined },
  );

  return { items: completions, isIncomplete: true };
}

export default onCompletion;
