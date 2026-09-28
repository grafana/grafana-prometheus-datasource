// NOTE: these two functions are similar to the escapeLabelValueIn* functions
// in language_utils.ts, but they are not exactly the same algorithm, and we found

import { type QueryVariableModel, type CustomVariableModel } from '@grafana/data';
import { config } from '@grafana/runtime';

export function interpolateQueryExpr(
  value: string | string[] = [],
  variable: QueryVariableModel | CustomVariableModel
) {
  // if no multi or include all do not regexEscape
  if (!variable.multi && !variable.includeAll) {
    return prometheusRegularEscape(value);
  }

  if (typeof value === 'string') {
    return prometheusSpecialRegexEscape(value);
  }

  const escapedValues = value.map((val) => prometheusSpecialRegexEscape(val));

  if (escapedValues.length === 1) {
    return escapedValues[0];
  }

  return '(' + escapedValues.join('|') + ')';
}

// no way to reuse one in the another or vice versa.
export function prometheusRegularEscape<T>(value: T) {
  if (typeof value !== 'string') {
    return value;
  }

  if (config.featureToggles.prometheusSpecialCharsInLabelValues) {
    // if the string looks like a complete label matcher (e.g. 'job="grafana"' or 'job=~"grafana"'),
    // don't escape the encapsulating quotes
    if (/^\w+(=|!=|=~|!~)".*"$/.test(value)) {
      return value;
    }

    return value
      .replace(/\\/g, '\\\\') // escape backslashes
      .replace(/"/g, '\\"'); // escape double quotes
  }

  // classic behavior
  return value
    .replace(/\\/g, '\\\\') // escape backslashes
    .replace(/'/g, "\\\\'"); // escape single quotes
}

export function prometheusSpecialRegexEscape<T>(value: T) {
  if (typeof value !== 'string') {
    return value;
  }

  if (config.featureToggles.prometheusSpecialCharsInLabelValues) {
    return value
      .replace(/\\/g, '\\\\\\\\') // escape backslashes
      .replace(/"/g, '\\\\\\"') // escape double quotes
      .replace(/[$^*{}\[\]\'+?.()|]/g, '\\\\$&'); // escape regex metacharacters
  }

  // classic behavior
  return value
    .replace(/\\/g, '\\\\\\\\') // escape backslashes
    .replace(/[$^*{}\[\]+?.()|]/g, '\\\\$&'); // escape regex metacharacters
}

// NOTE: the following 2 exported functions are very similar to the prometheus*Escape
// functions in datasource.ts, but they are not exactly the same algorithm, and we found
// no way to reuse one in the another or vice versa.

// Prometheus regular-expressions use the RE2 syntax (https://github.com/google/re2/wiki/Syntax),
// so every character that matches something in that list has to be escaped.
// the list of metacharacters is: *+?()|\.[]{}^$
// we make a javascript regular expression that matches those characters:
const RE2_METACHARACTERS = /[*+?()|\\.\[\]{}^$]/g;

function escapePrometheusRegexp(value: string): string {
  return value.replace(RE2_METACHARACTERS, '\\$&');
}

/**
 * Encodes a decoded label value for insertion between double quotes in a PromQL selector.
 * This is the inverse of {@link decodePromQLStringLiteral} for valid UTF-8 values.
 * @see https://prometheus.io/docs/prometheus/latest/querying/basics/#string-literals
 */
export function escapeLabelValueInExactSelector(labelValue: string): string {
  const simpleEscapes: Record<string, string> = {
    '\x07': '\\a',
    '\b': '\\b',
    '\f': '\\f',
    '\n': '\\n',
    '\r': '\\r',
    '\t': '\\t',
    '\v': '\\v',
    '\\': '\\\\',
    '"': '\\"',
  };

  let escaped = '';
  for (const character of labelValue) {
    if (character in simpleEscapes) {
      escaped += simpleEscapes[character];
      continue;
    }

    const codePoint = character.codePointAt(0)!;
    escaped += codePoint < 0x20 || codePoint === 0x7f ? `\\x${codePoint.toString(16).padStart(2, '0')}` : character;
  }
  return escaped;
}

export function escapeLabelValueInRegexSelector(labelValue: string): string {
  return escapeLabelValueInExactSelector(escapePrometheusRegexp(labelValue));
}

/**
 * Decodes a complete single-quoted, double-quoted, or backtick PromQL string literal.
 * Returns undefined when the syntax or its decoded bytes are not valid UTF-8.
 * This is the inverse of {@link escapeLabelValueInExactSelector} for double-quoted literals.
 * @see https://prometheus.io/docs/prometheus/latest/querying/basics/#string-literals
 */
export function decodePromQLStringLiteral(literal: string): string | undefined {
  if (literal.length < 2 || literal[0] !== literal[literal.length - 1]) {
    return undefined;
  }

  const quote = literal[0];
  const value = literal.slice(1, -1);
  if (quote === '`') {
    return value;
  }
  if (quote !== '"' && quote !== "'") {
    return undefined;
  }

  const bytes: number[] = [];
  const textEncoder = new TextEncoder();
  const appendCharacter = (character: string) => bytes.push(...textEncoder.encode(character));
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== '\\') {
      const codePoint = value.codePointAt(index)!;
      const character = String.fromCodePoint(codePoint);
      appendCharacter(character);
      index += character.length - 1;
      continue;
    }

    const escape = value[++index];
    const simpleEscapes: Record<string, string> = {
      a: '\x07',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
      v: '\v',
      '\\': '\\',
      '"': '"',
      "'": "'",
    };
    if (escape in simpleEscapes) {
      appendCharacter(simpleEscapes[escape]);
      continue;
    }

    const digits = escape === 'x' ? 2 : escape === 'u' ? 4 : escape === 'U' ? 8 : /^[0-7]$/.test(escape) ? 3 : 0;
    const radix = /^[0-7]$/.test(escape) ? 8 : 16;
    const encoded =
      radix === 8 ? escape + value.slice(index + 1, index + digits) : value.slice(index + 1, index + 1 + digits);
    if (
      digits === 0 ||
      encoded.length !== digits ||
      !new RegExp(`^[0-${radix === 8 ? '7' : '9a-fA-F'}]+$`).test(encoded)
    ) {
      return undefined;
    }

    const codePoint = Number.parseInt(encoded, radix);
    if (codePoint > (radix === 8 || escape === 'x' ? 0xff : 0x10ffff) || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      return undefined;
    }
    if (radix === 8 || escape === 'x') {
      bytes.push(codePoint);
    } else {
      appendCharacter(String.fromCodePoint(codePoint));
    }
    index += radix === 8 ? digits - 1 : digits;
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return undefined;
  }
}
