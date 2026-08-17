import type { ReactNode } from 'react';

interface SyntaxLanguage {
  readonly keywords: ReadonlySet<string>;
  readonly lineComments: ReadonlySet<string>;
  readonly blockComments: boolean;
  readonly builtins?: ReadonlySet<string>;
  readonly variables?: boolean;
}

function words(value: string): ReadonlySet<string> {
  return new Set(value.split(' '));
}

function cStyle(keywords: string): SyntaxLanguage {
  return {
    keywords: words(keywords),
    lineComments: new Set(['//']),
    blockComments: true,
  };
}

function hashStyle(keywords: string): SyntaxLanguage {
  return {
    keywords: words(keywords),
    lineComments: new Set(['#']),
    blockComments: false,
  };
}

const cKeywords =
  'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while';
const c = cStyle(cKeywords);
const cpp = cStyle(
  `${cKeywords} alignas alignof asm bool catch char8_t char16_t char32_t class concept consteval constexpr constinit const_cast co_await co_return co_yield decltype delete dynamic_cast explicit export friend mutable namespace new noexcept nullptr operator private protected public reinterpret_cast requires static_assert static_cast template this thread_local throw try typeid typename using virtual wchar_t`,
);
const go = cStyle(
  'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var',
);
const javascript = cStyle(
  'async await break case catch class const continue default delete do else export extends finally for function if import in instanceof let new return switch throw try typeof var while yield',
);
const typescript = cStyle(
  'abstract as async await break case catch class const declare else enum export extends for function if implements import interface keyof let namespace new private protected public readonly return satisfies static type typeof var',
);
const python = hashStyle(
  'and as async await break class continue def del elif else except finally for from global if import in is lambda not or pass raise return try while with yield',
);
const bash: SyntaxLanguage = {
  ...hashStyle(
    'case do done elif else esac export fi for function if in local readonly select then until while',
  ),
  builtins: words(
    'alias builtin cd command echo eval exec exit printf pwd read return set shift source test trap type ulimit umask unalias unset wait',
  ),
  variables: true,
};
const rust = cStyle(
  'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while',
);
const json: SyntaxLanguage = {
  keywords: new Set(),
  lineComments: new Set(),
  blockComments: false,
};

const languages: Readonly<Record<string, SyntaxLanguage>> = {
  c,
  h: c,
  'c++': cpp,
  cc: cpp,
  cpp,
  cxx: cpp,
  'h++': cpp,
  hh: cpp,
  hpp: cpp,
  hxx: cpp,
  go,
  golang: go,
  js: javascript,
  jsx: javascript,
  javascript,
  ts: typescript,
  tsx: typescript,
  typescript,
  py: python,
  python,
  bash,
  sh: bash,
  shell: bash,
  json,
  rs: rust,
  rust,
};

const literals = new Set(['false', 'nil', 'null', 'true', 'undefined']);
const tokenPattern =
  /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|\$(?:\{[A-Za-z_][\w]*\}|[A-Za-z_][\w]*|[0-9@#?$!*-])|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|\b(?:0x[\dA-Fa-f]+|\d+(?:\.\d+)?)\b|\b[A-Za-z_$][\w$]*\b)/g;

function tokenClass(token: string, language: SyntaxLanguage): string | null {
  if (
    (token.startsWith('//') && language.lineComments.has('//')) ||
    (token.startsWith('#') && language.lineComments.has('#')) ||
    (token.startsWith('/*') && language.blockComments)
  ) {
    return 'syntax-comment';
  }
  if (language.variables === true && token.startsWith('$')) return 'syntax-variable';
  if (/^["'`]/.test(token)) return 'syntax-string';
  if (/^(?:0x[\dA-Fa-f]+|\d)/.test(token)) return 'syntax-number';
  if (literals.has(token)) return 'syntax-literal';
  if (language.builtins?.has(token) === true) return 'syntax-builtin';
  if (language.keywords.has(token)) return 'syntax-keyword';
  return null;
}

/** Applies a deliberately small, dependency-free syntax palette to supported fenced languages. */
export function highlightCode(code: string, languageName: string | undefined): ReactNode {
  const language = languageName === undefined ? undefined : languages[languageName.toLowerCase()];
  if (language === undefined) return code;

  return code.split(tokenPattern).map((token, index) => {
    const className = tokenClass(token, language);
    return className === null ? (
      token
    ) : (
      <span className={className} key={`${String(index)}:${className}`}>
        {token}
      </span>
    );
  });
}
