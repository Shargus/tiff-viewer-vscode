/**
 * Band math expressions, e.g. `(B08 - B04) / (B08 + B04)` or `10 * log10(VV)`.
 *
 * The webview's content security policy forbids eval, so expressions are
 * parsed here and evaluated over whole arrays of pixels: every node of the
 * syntax tree is one tight loop, which is about as fast as compiled code.
 *
 * Grammar (usual precedence, `^` binds tightest and is right-associative):
 *   expr    := compare
 *   compare := sum (('<' | '<=' | '>' | '>=' | '==' | '!=') sum)?
 *   sum     := product (('+' | '-') product)*
 *   product := unary (('*' | '/' | '%') unary)*
 *   unary   := ('-' | '+') unary | power
 *   power   := atom (('^' | '**') unary)?
 *   atom    := number | name | name '(' expr (',' expr)* ')' | '(' expr ')'
 * Comparisons give 1 or 0. Names are bands, variables (named expressions
 * defined before, each computed once) or `pi`.
 */

type Node =
  | { kind: 'num'; value: number }
  | { kind: 'band'; sample: number }
  | { kind: 'var'; index: number }
  | { kind: 'neg'; arg: Node }
  | { kind: 'bin'; op: string; left: Node; right: Node }
  | { kind: 'call'; fn: string; args: Node[] };

export class ExpressionError extends Error {
  /** Index of the failing expression, when compiling several. */
  index?: number;
  /** Name of the failing variable, when the error is in a variable's definition. */
  variable?: string;

  constructor(
    message: string,
    readonly position: number,
  ) {
    super(message);
  }
}

/** Function name → [min args, max args]. */
const FUNCTIONS: Record<string, [number, number]> = {
  abs: [1, 1],
  sqrt: [1, 1],
  exp: [1, 1],
  log: [1, 1],
  log10: [1, 1],
  log2: [1, 1],
  floor: [1, 1],
  ceil: [1, 1],
  round: [1, 1],
  sin: [1, 1],
  cos: [1, 1],
  tan: [1, 1],
  atan2: [2, 2],
  pow: [2, 2],
  min: [2, Infinity],
  max: [2, Infinity],
  clamp: [3, 3],
  /** where(condition, a, b): a where condition is non-zero, else b. */
  where: [3, 3],
  /** isnan(x): 1 where x is NaN (no data), else 0. */
  isnan: [1, 1],
};

export const FUNCTION_NAMES = Object.keys(FUNCTIONS);

interface Token {
  type: 'num' | 'name' | 'op' | 'end';
  text: string;
  value?: number;
  pos: number;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const re = /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(\*\*|<=|>=|==|!=|[-+*/%^(),<>]))/y;
  let pos = 0;
  while (pos < source.length) {
    if (/^\s*$/.test(source.slice(pos))) break;
    re.lastIndex = pos;
    const m = re.exec(source);
    if (!m) {
      const at = pos + (source.slice(pos).length - source.slice(pos).trimStart().length);
      throw new ExpressionError(`Unexpected character '${source[at]}'`, at);
    }
    const start = m.index + (m[0].length - m[0].trimStart().length);
    if (m[1] !== undefined) tokens.push({ type: 'num', text: m[1], value: Number(m[1]), pos: start });
    else if (m[2] !== undefined) tokens.push({ type: 'name', text: m[2], pos: start });
    else tokens.push({ type: 'op', text: m[3], pos: start });
    pos = re.lastIndex;
  }
  tokens.push({ type: 'end', text: '', pos: source.length });
  return tokens;
}

function parse(
  source: string,
  bands: Record<string, number>,
  variables: Map<string, number>,
  /** Variables defined after this expression's (for a clearer error), or undefined when none exist. */
  laterVariables?: Set<string>,
): Node {
  const tokens = tokenize(source);
  let i = 0;
  const peek = () => tokens[i];
  const isOp = (...ops: string[]) => peek().type === 'op' && ops.includes(peek().text);
  const expect = (op: string) => {
    if (!isOp(op)) {
      const t = peek();
      throw new ExpressionError(t.type === 'end' ? `Missing '${op}'` : `Expected '${op}' but found '${t.text}'`, t.pos);
    }
    i++;
  };

  const compare = (): Node => {
    const left = sum();
    if (isOp('<', '<=', '>', '>=', '==', '!=')) {
      const op = tokens[i++].text;
      return { kind: 'bin', op, left, right: sum() };
    }
    return left;
  };
  const sum = (): Node => {
    let node = product();
    while (isOp('+', '-')) {
      const op = tokens[i++].text;
      node = { kind: 'bin', op, left: node, right: product() };
    }
    return node;
  };
  const product = (): Node => {
    let node = unary();
    while (isOp('*', '/', '%')) {
      const op = tokens[i++].text;
      node = { kind: 'bin', op, left: node, right: unary() };
    }
    return node;
  };
  const unary = (): Node => {
    if (isOp('-')) {
      i++;
      return { kind: 'neg', arg: unary() };
    }
    if (isOp('+')) {
      i++;
      return unary();
    }
    return power();
  };
  const power = (): Node => {
    const base = atom();
    if (isOp('^', '**')) {
      i++;
      return { kind: 'bin', op: '^', left: base, right: unary() };
    }
    return base;
  };
  const atom = (): Node => {
    const t = peek();
    if (t.type === 'num') {
      i++;
      return { kind: 'num', value: t.value! };
    }
    if (t.type === 'name') {
      i++;
      if (isOp('(')) {
        const range = FUNCTIONS[t.text];
        if (!range) throw new ExpressionError(`Unknown function '${t.text}'`, t.pos);
        i++;
        const args: Node[] = [];
        if (!isOp(')')) {
          args.push(compare());
          while (isOp(',')) {
            i++;
            args.push(compare());
          }
        }
        expect(')');
        if (args.length < range[0] || args.length > range[1]) {
          const count = range[0] === range[1] ? String(range[0]) : `at least ${range[0]}`;
          throw new ExpressionError(`${t.text}() takes ${count} argument${range[0] === 1 && range[1] === 1 ? '' : 's'}`, t.pos);
        }
        return { kind: 'call', fn: t.text, args };
      }
      // Variables shadow bands of the same name.
      const variable = variables.get(t.text);
      if (variable !== undefined) {
        return { kind: 'var', index: variable };
      }
      if (Object.prototype.hasOwnProperty.call(bands, t.text)) {
        return { kind: 'band', sample: bands[t.text] };
      }
      if (t.text === 'pi') return { kind: 'num', value: Math.PI };
      if (laterVariables?.has(t.text)) {
        throw new ExpressionError(`'${t.text}' is defined after this variable; a variable can only use the ones before it`, t.pos);
      }
      throw new ExpressionError(`Unknown ${laterVariables ? 'band or variable' : 'band'} '${t.text}'`, t.pos);
    }
    if (isOp('(')) {
      i++;
      const node = compare();
      expect(')');
      return node;
    }
    throw new ExpressionError(t.type === 'end' ? 'Incomplete expression' : `Unexpected '${t.text}'`, t.pos);
  };

  if (peek().type === 'end') throw new ExpressionError('Empty expression', 0);
  const node = compare();
  if (peek().type !== 'end') throw new ExpressionError(`Unexpected '${peek().text}'`, peek().pos);
  return node;
}

/** Values of one node: a constant, or one value per pixel. */
type Values = number | Float32Array;

const UNARY: Record<string, (x: number) => number> = {
  abs: Math.abs,
  sqrt: Math.sqrt,
  exp: Math.exp,
  log: Math.log,
  log10: Math.log10,
  log2: Math.log2,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  isnan: (x) => (x !== x ? 1 : 0),
};

const BINARY: Record<string, (a: number, b: number) => number> = {
  '+': (a, b) => a + b,
  '-': (a, b) => a - b,
  '*': (a, b) => a * b,
  '/': (a, b) => a / b,
  '%': (a, b) => a % b,
  '^': (a, b) => a ** b,
  '<': (a, b) => (a < b ? 1 : 0),
  '<=': (a, b) => (a <= b ? 1 : 0),
  '>': (a, b) => (a > b ? 1 : 0),
  '>=': (a, b) => (a >= b ? 1 : 0),
  '==': (a, b) => (a === b ? 1 : 0),
  '!=': (a, b) => (a !== b ? 1 : 0),
  pow: (a, b) => a ** b,
  atan2: Math.atan2,
  min: (a, b) => (a !== a || b !== b ? NaN : a < b ? a : b),
  max: (a, b) => (a !== a || b !== b ? NaN : a > b ? a : b),
};

function map1(x: Values, f: (x: number) => number, n: number): Values {
  if (typeof x === 'number') return f(x);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = f(x[i]);
  return out;
}

function map2(a: Values, b: Values, op: string, n: number): Values {
  const f = BINARY[op];
  if (typeof a === 'number' && typeof b === 'number') return f(a, b);
  const out = new Float32Array(n);
  // The common arithmetic cases are written out so that the loops inline.
  if (typeof a !== 'number' && typeof b !== 'number') {
    switch (op) {
      case '+': for (let i = 0; i < n; i++) out[i] = a[i] + b[i]; return out;
      case '-': for (let i = 0; i < n; i++) out[i] = a[i] - b[i]; return out;
      case '*': for (let i = 0; i < n; i++) out[i] = a[i] * b[i]; return out;
      case '/': for (let i = 0; i < n; i++) out[i] = a[i] / b[i]; return out;
    }
    for (let i = 0; i < n; i++) out[i] = f(a[i], b[i]);
  } else if (typeof a !== 'number') {
    const k = b as number;
    switch (op) {
      case '+': for (let i = 0; i < n; i++) out[i] = a[i] + k; return out;
      case '-': for (let i = 0; i < n; i++) out[i] = a[i] - k; return out;
      case '*': for (let i = 0; i < n; i++) out[i] = a[i] * k; return out;
      case '/': for (let i = 0; i < n; i++) out[i] = a[i] / k; return out;
    }
    for (let i = 0; i < n; i++) out[i] = f(a[i], k);
  } else {
    const k = a;
    const v = b as Float32Array;
    switch (op) {
      case '+': for (let i = 0; i < n; i++) out[i] = k + v[i]; return out;
      case '-': for (let i = 0; i < n; i++) out[i] = k - v[i]; return out;
      case '*': for (let i = 0; i < n; i++) out[i] = k * v[i]; return out;
      case '/': for (let i = 0; i < n; i++) out[i] = k / v[i]; return out;
    }
    for (let i = 0; i < n; i++) out[i] = f(k, v[i]);
  }
  return out;
}

export interface CompiledExpressions {
  /** Distinct sample indices the expressions read, in the order `evaluate` expects their data. */
  samples: number[];
  /**
   * Evaluates every expression for `n` pixels. `data[k]` holds the values of
   * `samples[k]`; values equal to `noData` count as missing (NaN).
   */
  evaluate(data: ArrayLike<number>[], n: number, noData: number | null): Float32Array[];
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parses expressions over bands (name → 0-based sample index) and optional
 * variables: named expressions, in order, each of which may use the bands
 * and the variables defined before it. Throws ExpressionError, with `index`
 * set to the failing expression or `variable` to the failing variable.
 */
export function compileExpressions(
  sources: string[],
  bands: Record<string, number>,
  variables: Record<string, string> = {},
): CompiledExpressions {
  const variableIndex = new Map<string, number>();
  const variableTrees: Node[] = [];
  const names = Object.keys(variables);
  const hasVariables = names.length > 0;
  for (const [position, [name, source]] of Object.entries(variables).entries()) {
    try {
      if (!IDENTIFIER.test(name) || FUNCTIONS[name] || name === 'pi') {
        throw new ExpressionError(`'${name}' cannot be a variable name: use letters, digits and _, not starting with a digit, and not a function name`, 0);
      }
      variableTrees.push(parse(String(source), bands, variableIndex, new Set(names.slice(position))));
      variableIndex.set(name, variableTrees.length - 1);
    } catch (error) {
      if (error instanceof ExpressionError) error.variable = name;
      throw error;
    }
  }
  const trees = sources.map((source, index) => {
    try {
      return parse(source, bands, variableIndex, hasVariables ? new Set() : undefined);
    } catch (error) {
      if (error instanceof ExpressionError) error.index = index;
      throw error;
    }
  });
  const samples: number[] = [];
  const visited = new Set<number>();
  const collect = (node: Node): void => {
    if (node.kind === 'band' && !samples.includes(node.sample)) samples.push(node.sample);
    if (node.kind === 'var' && !visited.has(node.index)) {
      visited.add(node.index);
      collect(variableTrees[node.index]);
    }
    if (node.kind === 'neg') collect(node.arg);
    if (node.kind === 'bin') {
      collect(node.left);
      collect(node.right);
    }
    if (node.kind === 'call') node.args.forEach(collect);
  };
  trees.forEach(collect);

  return {
    samples,
    evaluate(data, n, noData) {
      // Each band is converted to floats (no data → NaN) once, however often it is used.
      const bandValues = new Map<number, Float32Array>();
      const band = (sample: number) => {
        let values = bandValues.get(sample);
        if (!values) {
          const src = data[samples.indexOf(sample)];
          values = new Float32Array(n);
          for (let i = 0; i < n; i++) {
            const v = src[i];
            values[i] = v === noData ? NaN : v;
          }
          bandValues.set(sample, values);
        }
        return values;
      };
      // Each variable is computed once, however often it is used.
      const variableValues = new Map<number, Values>();
      const evalNode = (node: Node): Values => {
        switch (node.kind) {
          case 'num':
            return node.value;
          case 'band':
            return band(node.sample);
          case 'var': {
            let values = variableValues.get(node.index);
            if (values === undefined) {
              values = evalNode(variableTrees[node.index]);
              variableValues.set(node.index, values);
            }
            return values;
          }
          case 'neg':
            return map1(evalNode(node.arg), (x) => -x, n);
          case 'bin':
            return map2(evalNode(node.left), evalNode(node.right), node.op, n);
          case 'call': {
            const args = node.args.map(evalNode);
            if (UNARY[node.fn]) return map1(args[0], UNARY[node.fn], n);
            if (node.fn === 'min' || node.fn === 'max') return args.reduce((a, b) => map2(a, b, node.fn, n));
            if (node.fn === 'clamp') return map2(map2(args[0], args[1], 'max', n), args[2], 'min', n);
            if (node.fn === 'where') {
              const [c, a, b] = args;
              if (typeof c === 'number') return c !== 0 && c === c ? a : b;
              const out = new Float32Array(n);
              for (let i = 0; i < n; i++) {
                const ci = c[i];
                out[i] = ci !== ci ? NaN : ci !== 0 ? (typeof a === 'number' ? a : a[i]) : typeof b === 'number' ? b : b[i];
              }
              return out;
            }
            return map2(args[0], args[1], node.fn, n);
          }
        }
      };
      return trees.map((tree) => {
        const values = evalNode(tree);
        if (typeof values === 'number') return new Float32Array(n).fill(values);
        // A bare band or variable reference returns a shared array; copy so results are independent.
        return tree.kind === 'band' || tree.kind === 'var' ? values.slice() : values;
      });
    },
  };
}

/** Turns a band description (e.g. "B04", "VV", "Band 1") into a variable name, or undefined. */
export function bandIdentifier(description: string): string | undefined {
  const name = description.trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!name) return undefined;
  const id = /^[0-9]/.test(name) ? `_${name}` : name;
  return FUNCTIONS[id] || id === 'pi' ? undefined : id;
}
