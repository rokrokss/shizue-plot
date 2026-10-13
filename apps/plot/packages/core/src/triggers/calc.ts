/**
 * RisuAI's `calcString` (`process/infunctions.ts`), which `v2Calculate` runs:
 * parentheses evaluated innermost first, each group through a shunting-yard
 * conversion and a stack machine. Ported as it is rather than mapped onto our
 * expression evaluator (`evaluateExpression`), because the two disagree on
 * precedence and on what an odd token means, and a card's arithmetic was
 * written against this one: `&` and `|` sit with the comparisons, a token that
 * does not read as a number is skipped, an operator with nothing in front of it
 * works on 0, and the result is JavaScript's own number text, unrounded.
 */

type Operator = '+' | '-' | '*' | '/' | '^' | '%' | '<' | '>' | '|' | '&' | '≤' | '≥' | '=' | '≠' | '!';

const OPERATORS: Record<Operator, { precedence: number; left: boolean }> = {
  '+': { precedence: 2, left: true },
  '-': { precedence: 2, left: true },
  '*': { precedence: 3, left: true },
  '/': { precedence: 3, left: true },
  '^': { precedence: 4, left: true },
  '%': { precedence: 3, left: true },
  '<': { precedence: 1, left: true },
  '>': { precedence: 1, left: true },
  '|': { precedence: 1, left: true },
  '&': { precedence: 1, left: true },
  '≤': { precedence: 1, left: true },
  '≥': { precedence: 1, left: true },
  '=': { precedence: 1, left: true },
  '≠': { precedence: 1, left: true },
  '!': { precedence: 5, left: false },
};

const isOperator = (token: string | undefined): token is Operator =>
  token !== undefined && Object.hasOwn(OPERATORS, token);

/** RisuAI's test for a number token: `parseFloat` truthy, or exactly `0`. */
const isNumberToken = (token: string): boolean => Boolean(parseFloat(token)) || token === '0';

function toRpn(source: string): string {
  const expression = source.replace(/\s+/g, '');
  const tokens: string[] = [];
  let last = '';
  for (let i = 0; i < expression.length; i += 1) {
    const char = expression[i]!;
    if (char === '-' && (i === 0 || isOperator(expression[i - 1]) || expression[i - 1] === '(')) {
      last += char;
    } else if (isOperator(char)) {
      tokens.push(last !== '' ? last : '0');
      last = '';
      tokens.push(char);
    } else {
      last += char;
    }
  }
  tokens.push(last !== '' ? last : '0');

  let output = '';
  const stack: Operator[] = [];
  for (const token of tokens) {
    if (isNumberToken(token)) {
      output += `${token} `;
    } else if (isOperator(token)) {
      const { precedence, left } = OPERATORS[token];
      while (stack.length > 0) {
        const top = OPERATORS[stack[stack.length - 1]!];
        if ((left && precedence <= top.precedence) || (!left && precedence < top.precedence)) {
          output += `${stack.pop()} `;
        } else {
          break;
        }
      }
      stack.push(token);
    }
  }
  while (stack.length > 0) output += `${stack.pop()} `;
  return output.trim();
}

function runRpn(expression: string): number | undefined {
  const stack: (number | undefined)[] = [];
  for (const token of expression.split(' ')) {
    if (isNumberToken(token)) {
      stack.push(parseFloat(token));
      continue;
    }
    const b = stack.pop() as number;
    const a = stack.pop() as number;
    switch (token) {
      case '+': stack.push(a + b); break;
      case '-': stack.push(a - b); break;
      case '*': stack.push(a * b); break;
      case '/': stack.push(a / b); break;
      case '^': stack.push(a ** b); break;
      case '%': stack.push(a % b); break;
      case '<': stack.push(a < b ? 1 : 0); break;
      case '>': stack.push(a > b ? 1 : 0); break;
      case '|': stack.push(a || b); break;
      case '&': stack.push(a && b); break;
      case '≤': stack.push(a <= b ? 1 : 0); break;
      case '≥': stack.push(a >= b ? 1 : 0); break;
      case '=': stack.push(a === b ? 1 : 0); break;
      case '≠': stack.push(a !== b ? 1 : 0); break;
      case '!': stack.push(b ? 0 : 1); break;
    }
  }
  return stack.length === 0 ? 0 : stack.pop();
}

/** A variable read the way `$name` and `@name` read one here: its number, or 0. */
const numeric = (value: string | undefined): string => {
  const parsed = parseFloat(value ?? '');
  return Number.isNaN(parsed) ? '0' : String(parsed);
};

function evaluateGroup(
  text: string,
  chatVariable: (name: string) => string | undefined,
  globalVariable: (name: string) => string | undefined,
): number | undefined {
  const prepared = text
    .replace(/\$([a-zA-Z0-9_]+)/g, (_ref, name: string) => numeric(chatVariable(name)))
    .replace(/@([a-zA-Z0-9_]+)/g, (_ref, name: string) => numeric(globalVariable(name)))
    .replace(/&&/g, '&')
    .replace(/\|\|/g, '|')
    .replace(/<=/g, '≤')
    .replace(/>=/g, '≥')
    .replace(/==/g, '=')
    .replace(/!=/g, '≠')
    .replace(/null/gi, '0');
  return runRpn(toRpn(prepared));
}

/**
 * The value of `text`. Undefined is what RisuAI's stack machine hands back for
 * an expression that leaves nothing behind — its caller then fails reading it.
 */
export function risuCalculate(
  text: string,
  chatVariable: (name: string) => string | undefined = () => undefined,
  globalVariable: (name: string) => string | undefined = () => undefined,
): number | undefined {
  const depth: string[] = [''];
  for (const char of text) {
    if (char === '(') {
      depth.push('');
    } else if (char === ')' && depth.length > 1) {
      const result = evaluateGroup(depth.pop()!, chatVariable, globalVariable);
      depth[depth.length - 1] += String(result);
    } else {
      depth[depth.length - 1] += char;
    }
  }
  return evaluateGroup(depth.join(''), chatVariable, globalVariable);
}
