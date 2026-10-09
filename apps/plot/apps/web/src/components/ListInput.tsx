'use client';

import { useEffect, useState } from 'react';
import { TextInput } from './ui';

const parse = (text: string): string[] =>
  text
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

const same = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((item, index) => item === b[index]);

/**
 * Comma-separated string list. The raw text is kept locally so that typing a
 * separator or a trailing space does not fight with the parsed value.
 */
export function ListInput({
  value,
  onChange,
  placeholder,
}: {
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
}) {
  const [text, setText] = useState(() => value.join(', '));

  useEffect(() => {
    setText((current) => (same(parse(current), value) ? current : value.join(', ')));
  }, [value]);

  return (
    <TextInput
      value={text}
      placeholder={placeholder}
      onChange={(event) => {
        setText(event.target.value);
        onChange(parse(event.target.value));
      }}
    />
  );
}
