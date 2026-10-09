import type { SVGProps } from 'react';

const paths = {
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4',
  attach: 'm9 12 6-6a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L13 2m-7 12 8-8',
  explore: 'm12 3 3 6 6 3-6 3-3 6-3-6-6-3 6-3 3-6Z',
  chats: 'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2Zm2 5h10M7 13h6',
  create: 'm14 5 5 5M4 20l5-1L21 7a2.1 2.1 0 0 0-5-5L4 14l-1 7ZM13 20h8',
  menu: 'M4 6h16M4 12h16M4 18h16',
  arrow: 'M4 12h16m-6-6 6 6-6 6',
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  book: 'M12 5v16m0-16C8 2 4 3 2 4v15c3-1 6-1 10 2 4-3 7-3 10-2V4c-2-1-6-2-10 1Z',
} as const;

export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: keyof typeof paths }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d={paths[name]} />
    </svg>
  );
}
