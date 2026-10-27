// Lokale Typ-Deklaration für markdown-it (v14 liefert keine eigenen Types).
// @types/markdown-it wird bei NODE_ENV=production nicht installiert (devDep)
// und verursacht sonst TS7016 beim tsc --noEmit. Diese Declarations-Datei
// ist unabhängig vom Installationsmodus und damit robust.
declare module "markdown-it" {
  export interface Token {
    type: string;
    tag: string;
    attrs: [string, string][] | null;
    map: [number, number] | null;
    nesting: number;
    level: number;
    children: Token[] | null;
    content: string;
    markup: string;
    info: string;
    meta: unknown;
    block: boolean;
    hidden: boolean;
    attrGet(name: string): string | null;
    attrSet(name: string, value: string): void;
  }

  export interface Options {
    html?: boolean;
    xhtmlOut?: boolean;
    breaks?: boolean;
    langPrefix?: string;
    linkify?: boolean;
    typographer?: boolean;
    quotes?: string | string[];
    highlight?: (str: string, lang: string, attrs: string) => string;
    [key: string]: unknown;
  }

  export default class MarkdownIt {
    constructor(options?: Options | string);
    render(src: string, env?: unknown): string;
    parse(src: string, env?: unknown): Token[];
    renderer: {
      render(tokens: Token[], options: Options, env: unknown): string;
      renderToken(tokens: Token[], idx: number, options: Options): string;
      rules: Record<string, unknown>;
    };
    utils: {
      escapeHtml(str: string): string;
      [key: string]: unknown;
    };
    use(plugin: unknown, ...params: unknown[]): this;
    set(options: Options): this;
    enable(rule: string | string[]): this;
    disable(rule: string | string[]): this;
  }
}
