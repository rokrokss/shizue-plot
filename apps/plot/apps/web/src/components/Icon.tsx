import type { SVGProps } from 'react';

const paths = {
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4',
  bolt: 'M13 2 4 14h7l-1 8 9-12h-7l1-8Z',
  refresh: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5',
  wand: 'M15 4V2m0 14v-2M8 9h2m10 0h2m-4.2 2.8L19 13m-4-4L4 20m13.8-13.8L19 5M12.2 6.2 11 5',
  attach: 'm9 12 6-6a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L13 2m-7 12 8-8',
  explore: 'm12 3 3 6 6 3-6 3-3 6-3-6-6-3 6-3 3-6Z',
  chats: 'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2Zm2 5h10M7 13h6',
  create: 'm14 5 5 5M4 20l5-1L21 7a2.1 2.1 0 0 0-5-5L4 14l-1 7ZM13 20h8',
  menu: 'M4 6h16M4 12h16M4 18h16',
  chevron: 'm6 9 6 6 6-6',
  back: 'm15 18-6-6 6-6',
  arrow: 'M4 12h16m-6-6 6 6-6 6',
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  book: 'M12 5v16m0-16C8 2 4 3 2 4v15c3-1 6-1 10 2 4-3 7-3 10-2V4c-2-1-6-2-10 1Z',
  volume: 'M11 5 6 9H2v6h4l5 4V5Zm4.5 3.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14',
  volumeOff: 'M11 5 6 9H2v6h4l5 4V5Zm12 4-6 6m0-6 6 6',
  sliders: 'M21 4h-7M10 4H3m18 8h-9m-4 0H3m18 8h-5m-4 0H3M14 2v4m-6 4v4m8 4v4',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Zm14 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'm5 12 5 5 9-10',
  eyeOff:
    'M17.94 17.94A10 10 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A9 9 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24M1 1l22 22',
} as const;

export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: keyof typeof paths }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d={paths[name]} />
    </svg>
  );
}
