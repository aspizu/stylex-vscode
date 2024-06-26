import type {
  ArrayExpression,
  ComputedPropName,
  Expression,
  Span,
  TemplateElement,
} from "@swc/types";
import StateManager from "./state-manager";
import { NodeType } from "./walk";

type ResultType =
  | {
      value: InnerType;
      static: false;
    }
  | {
      value: InnerType;
      static: true;
      span: Span;
    }
  | {
      id: string;
      static: true;
      span: Span;
    };

type InnerType =
  | ResultType[]
  | string
  | number
  | boolean
  | null
  | undefined
  | RegExp
  | Record<string, ResultType>
  | bigint;

function processArrayExpression(
  node: ArrayExpression,
  stateManager: StateManager,
) {
  const result = node.elements.reduce<any[]>((accumulator, exprOrSpread) => {
    if (!exprOrSpread || !accumulator) return accumulator;
    if (exprOrSpread.spread) {
      const result = evaluate(exprOrSpread.expression, stateManager);

      if (!result.static) {
        accumulator.push(result);
      }

      accumulator.push(
        ...(<any[]>(
          (result &&
          typeof result === "object" &&
          (Array.isArray(result) ||
            (Symbol.iterator in result &&
              typeof result[Symbol.iterator] === "function"))
            ? result
            : [result])
        )),
      );
    } else {
      accumulator.push(evaluate(exprOrSpread.expression, stateManager));
    }
    return accumulator;
  }, []);

  return { value: result, static: true, span: node.span } satisfies ResultType;
}

/**
 * Evaluates an expression statically and returns the result
 */
export function evaluate(
  node: Expression | ComputedPropName | TemplateElement | NodeType,
  stateManager: StateManager,
): ResultType {
  switch (node.type) {
    case "StringLiteral":
    case "NumericLiteral":
    case "BooleanLiteral":
    case "BigIntLiteral":
      return { value: node.value, static: true, span: node.span };
    case "NullLiteral":
      return { value: null, static: true, span: node.span };
    case "RegExpLiteral":
      return {
        value: new RegExp(node.pattern, node.flags),
        static: true,
        span: node.span,
      };
    case "Invalid":
      throw new Error("Invalid expression");
    case "Identifier":
      if (node.value === "undefined")
        return { value: undefined, static: true, span: node.span };
      else {
        return { id: node.value, static: true, span: node.span };
      }
    case "ArrayExpression": {
      return processArrayExpression(node, stateManager);
    }

    case "ObjectExpression": {
      const result = node.properties.reduce<Record<string, ResultType>>(
        (accumulator, property) => {
          if (property.type === "SpreadElement") {
            const result = evaluate(property.arguments, stateManager);
            if (result && typeof result === "object" && "value" in result) {
              if (!result.static) return accumulator;
              accumulator = Object.assign(accumulator, result.value);
            }
            return accumulator;
          }

          switch (property.type) {
            case "KeyValueProperty":
            case "AssignmentProperty": {
              const keyVal = evaluate(property.key, stateManager);
              if (
                "value" in keyVal &&
                (typeof keyVal.value === "string" ||
                  typeof keyVal.value === "number" ||
                  typeof keyVal.value === "symbol")
              ) {
                accumulator[keyVal.value] = evaluate(
                  property.value,
                  stateManager,
                );
              }
              break;
            }

            case "GetterProperty":
            case "SetterProperty":
            case "MethodProperty": {
              return accumulator;
            }

            case "Identifier": {
              const result = evaluate(property, stateManager);
              if (!result.static) return accumulator;
              accumulator[property.value] = result;
              break;
            }
          }

          return accumulator;
        },
        {},
      );

      return { value: result, static: true, span: node.span };
    }

    case "ArrowFunctionExpression":
    case "FunctionExpression":
      return { value: undefined, static: false };

    case "AwaitExpression": {
      const result = evaluate(node.argument, stateManager);
      if (!result.static) return { value: undefined, static: false };
      return result;
    }

    case "BinaryExpression": {
      const left = evaluate(node.left, stateManager);
      const right = evaluate(node.right, stateManager);

      if (!left.static || !right.static)
        return { value: undefined, static: false };
      let result;

      if ("id" in left) return { value: undefined, static: false };
      if ("id" in right) return { value: undefined, static: false };

      switch (node.operator) {
        case "==":
          result = left.value == right.value;
          break;
        case "!=":
          result = left.value != right.value;
          break;
        case "===":
          result = left.value === right.value;
          break;
        case "!==":
          result = left.value !== right.value;
          break;
        case "<":
          if (left.value == null || right.value == null) {
            result = false;
          } else result = left.value < right.value;
          break;
        case "<=":
          if (left.value == null || right.value == null) {
            result = false;
          } else result = left.value <= right.value;
          break;
        case ">":
          if (left.value == null || right.value == null) {
            result = false;
          } else result = left.value > right.value;
          break;
        case ">=":
          if (left.value == null || right.value == null) {
            result = false;
          } else result = left.value >= right.value;
          break;
        case "in":
          try {
            // @ts-expect-error -- Error handled
            result = left.value in right.value;
          } catch {
            result = false;
          }
          break;
        case "instanceof":
          try {
            // @ts-expect-error -- Error handled
            result = left.value instanceof right.value;
          } catch {
            result = false;
          }
          break;
        case "&&":
          result = left.value && right.value;
          break;
        case "||":
          result = left.value || right.value;
          break;
        case "??":
          result = left.value ?? right.value;
          break;
      }
      if (typeof result !== "undefined")
        return { value: result, static: true, span: node.span };

      if (
        (typeof left.value !== "number" &&
          typeof left.value !== "bigint" &&
          typeof left.value !== "string") ||
        (typeof right.value !== "number" &&
          typeof right.value !== "bigint" &&
          typeof right.value !== "string") ||
        typeof left.value !== typeof right.value
      ) {
        return { value: undefined, static: true, span: node.span };
      }

      // Typescript doesn't have a way to narrow down a type dependant on another type as of writing
      const lr = [left.value, right.value] as [number, number];

      switch (node.operator) {
        case "<<":
          result = lr[0] << lr[1];
          break;
        case ">>":
          result = lr[0] >> lr[1];
          break;
        case ">>>":
          result = lr[0] >>> lr[1];
          break;
        case "+":
          result = lr[0] + lr[1];
          break;
        case "-":
          result = lr[0] - lr[1];
          break;
        case "*":
          result = lr[0] * lr[1];
          break;
        case "/":
          result = lr[0] / lr[1];
          break;
        case "%":
          result = lr[0] % lr[1];
          break;
        case "**":
          result = lr[0] ** lr[1];
          break;
        case "|":
          result = lr[0] | lr[1];
          break;
        case "^":
          result = lr[0] ^ lr[1];
          break;
        case "&":
          result = lr[0] & lr[1];
          break;
        default:
          throw new Error("Unknown binary operator");
      }

      return { value: result, static: true, span: node.span };
    }

    case "JSXElement":
    case "JSXFragment":
    case "JSXEmptyExpression":
    case "JSXMemberExpression":
    case "JSXNamespacedName":
    case "JSXText":
      return { value: undefined, static: false };

    case "TsAsExpression":
    case "TsNonNullExpression":
    case "TsConstAssertion":
    case "TsTypeAssertion":
    case "TsInstantiation":
      return evaluate(node.expression, stateManager);

    case "ParenthesisExpression":
      return evaluate(node.expression, stateManager);

    case "UnaryExpression": {
      const result = evaluate(node.argument, stateManager);
      if (!result.static || "id" in result)
        return { value: undefined, static: false };
      if (result.value == null)
        return { value: undefined, static: true, span: node.span };

      switch (node.operator) {
        case "+":
          try {
            // @ts-expect-error -- Error handled
            return { value: +result.value, static: true, span: node.span };
          } catch {
            return { value: undefined, static: true, span: node.span };
          }
        case "-":
          return { value: -result.value, static: true, span: node.span };
        case "!":
          return { value: !result.value, static: true, span: node.span };
        case "~":
          return { value: ~result.value, static: true, span: node.span };
        case "typeof":
          return { value: typeof result.value, static: true, span: node.span };
        case "void":
          return { value: undefined, static: true, span: node.span };
        case "delete":
          return { value: undefined, static: false };
        default:
          throw new Error("Unknown unary operator");
      }
    }

    case "AssignmentExpression":
      return evaluate(node.right, stateManager);

    case "ThisExpression":
      return { value: undefined, static: false };

    case "ConditionalExpression": {
      const test = evaluate(node.test, stateManager);
      if (!test.static || "id" in test)
        return { value: undefined, static: false };

      if (test.value) {
        return evaluate(node.consequent, stateManager);
      } else {
        return evaluate(node.alternate, stateManager);
      }
    }

    case "SuperPropExpression":
      return { value: undefined, static: false };

    case "TaggedTemplateExpression":
      return { value: undefined, static: false };

    case "TemplateLiteral": {
      const values = [];
      let quasisIndex = 0;
      let expressionsIndex = 0;
      let currentQuasi = true;
      const expressions = "expressions" in node ? node.expressions : [];
      if (!("quasis" in node)) return { value: undefined, static: false };

      while (
        currentQuasi
          ? quasisIndex < node.quasis.length
          : expressionsIndex < expressions.length
      ) {
        if (currentQuasi) {
          const result = evaluate(node.quasis[quasisIndex], stateManager);
          if (!result.static || "id" in result)
            return { value: undefined, static: false };
          values.push(result.value);
          ++quasisIndex;
        } else {
          const result = evaluate(expressions[expressionsIndex], stateManager);
          if (!result.static) return { value: undefined, static: false };
          if ("id" in result) {
            values.push(`var(--${result.id})`);
          } else {
            values.push(result.value);
          }
          ++expressionsIndex;
        }
        currentQuasi = !currentQuasi;
      }

      return { value: values.join(""), static: true, span: node.span };
    }

    case "TemplateElement":
      return { value: node.cooked || node.raw, static: true, span: node.span };

    case "NewExpression":
      return { value: undefined, static: false };

    case "ClassExpression":
      return { value: undefined, static: false };

    case "CallExpression": {
      if (
        (node.callee.type === "MemberExpression" &&
          node.callee.object.type === "Identifier" &&
          stateManager.verifyStylexIdentifier(node.callee.object.value) &&
          node.callee.property.type === "Identifier" &&
          node.callee.property.value === "firstThatWorks") ||
        (node.callee.type === "Identifier" &&
          stateManager.verifyNamedImport(node.callee.value) ===
            "firstThatWorks")
      ) {
        const result = processArrayExpression(
          {
            type: "ArrayExpression",
            span: node.span,
            elements: node.arguments,
          },
          stateManager,
        );

        result.value = result.value.reverse();

        return result;
      }

      return { value: undefined, static: false };
    }

    case "Computed": {
      return evaluate(node.expression, stateManager);
    }

    case "MemberExpression": {
      const object = evaluate(node.object, stateManager);
      if (!object.static) return { value: undefined, static: false };
      const property = evaluate(node.property, stateManager);
      if (!property.static) return { value: undefined, static: false };

      const propertyKey = "id" in property ? property.id : property.value;

      return "id" in object
        ? {
            id: `${object.id}.${propertyKey}`,
            static: true,
            span: node.span,
          }
        : {
            value:
              object.value == null
                ? object.value
                : typeof propertyKey === "string"
                  ? // @ts-expect-error -- Ignore member expression strict rules
                    object.value[propertyKey]
                  : undefined,
            static: true,
            span: node.span,
          };
    }

    case "OptionalChainingExpression":
      return { value: undefined, static: false };

    case "UpdateExpression":
      return { value: undefined, static: false };

    case "YieldExpression":
      return { value: undefined, static: false };

    case "MetaProperty":
      return { value: undefined, static: false };

    case "PrivateName":
      return evaluate(node.id, stateManager);

    case "SequenceExpression":
      return evaluate(
        node.expressions[node.expressions.length - 1],
        stateManager,
      );

    default:
      return { value: undefined, static: false };
  }
}
