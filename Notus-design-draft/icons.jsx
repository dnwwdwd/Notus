// icons.jsx — small inline SVG icon set for Notus
// All icons 16×16 by default, stroke-based, currentColor

const Icon = ({ d, size = 16, stroke = 1.6, fill = 'none', viewBox = '0 0 24 24', children, style }) => (
  <svg width={size} height={size} viewBox={viewBox}
       fill={fill} stroke="currentColor" strokeWidth={stroke}
       strokeLinecap="round" strokeLinejoin="round" style={style}>
    {d ? <path d={d} /> : children}
  </svg>
);

const I = {
  // Navigation / chrome
  settings: (p) => <Icon {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1A2 2 0 1 1 4.3 17l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1A2 2 0 1 1 7 4.3l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1A2 2 0 1 1 19.7 7l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></Icon>,
  folder: (p) => <Icon {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></Icon>,
  folderOpen: (p) => <Icon {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2M3 7v11a2 2 0 0 0 2 2h13.5a2 2 0 0 0 1.9-1.4l2-6A1 1 0 0 0 21.5 11H5a2 2 0 0 0-2 2V7z"/></Icon>,
  file: (p) => <Icon {...p}><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></Icon>,
  list: (p) => <Icon {...p}><path d="M3 6h18M3 12h18M3 18h18"/></Icon>,
  search: (p) => <Icon {...p}><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></Icon>,
  chevronRight: (p) => <Icon {...p}><path d="m9 6 6 6-6 6"/></Icon>,
  chevronDown: (p) => <Icon {...p}><path d="m6 9 6 6 6-6"/></Icon>,
  plus: (p) => <Icon {...p}><path d="M12 5v14M5 12h14"/></Icon>,
  filePlus: (p) => <Icon {...p}><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M12 13v6M9 16h6"/></Icon>,
  folderPlus: (p) => <Icon {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v6M9 14h6"/></Icon>,
  bold: (p) => <Icon {...p}><path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z"/></Icon>,
  italic: (p) => <Icon {...p}><path d="M19 4h-9M14 20H5M15 4 9 20"/></Icon>,
  strike: (p) => <Icon {...p}><path d="M4 12h16M17 7a4 4 0 0 0-4-3H9a3 3 0 0 0 0 6h2M8 17a4 4 0 0 0 4 3h3a3 3 0 0 0 0-6"/></Icon>,
  heading: (p) => <Icon {...p}><path d="M6 4v16M18 4v16M6 12h12"/></Icon>,
  link: (p) => <Icon {...p}><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></Icon>,
  image: (p) => <Icon {...p}><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/></Icon>,
  code: (p) => <Icon {...p}><path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 4l-4 16"/></Icon>,
  quote: (p) => <Icon {...p}><path d="M7 7H4v6h5l-2 4M17 7h-3v6h5l-2 4"/></Icon>,
  divider: (p) => <Icon {...p}><path d="M4 12h16M8 6h8M8 18h8"/></Icon>,
  listUl: (p) => <Icon {...p}><path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1" fill="currentColor" stroke="none"/></Icon>,
  listOl: (p) => <Icon {...p}><path d="M10 6h11M10 12h11M10 18h11M4 4v4M3 8h2M3 16h3a1 1 0 0 1 0 2H3.5a1 1 0 0 0 0 2H6"/></Icon>,
  undo: (p) => <Icon {...p}><path d="M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-4"/></Icon>,
  redo: (p) => <Icon {...p}><path d="m15 14 5-5-5-5M20 9H9a5 5 0 0 0 0 10h4"/></Icon>,
  split: (p) => <Icon {...p}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></Icon>,
  sparkles: (p) => <Icon {...p}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/></Icon>,
  send: (p) => <Icon {...p}><path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/></Icon>,
  check: (p) => <Icon {...p}><path d="M5 13l4 4L19 7"/></Icon>,
  x: (p) => <Icon {...p}><path d="M6 6l12 12M6 18 18 6"/></Icon>,
  warn: (p) => <Icon {...p}><path d="M12 3 2 21h20zM12 10v5M12 18h.01"/></Icon>,
  info: (p) => <Icon {...p}><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v5h1"/></Icon>,
  hourglass: (p) => <Icon {...p}><path d="M6 3h12M6 21h12M7 3v4c0 3 5 3 5 5s-5 2-5 5v4M17 3v4c0 3-5 3-5 5s5 2 5 5v4"/></Icon>,
  eye: (p) => <Icon {...p}><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></Icon>,
  trash: (p) => <Icon {...p}><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M5 6l1 14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-14M10 11v6M14 11v6"/></Icon>,
  dots: (p) => <Icon {...p}><circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.2" fill="currentColor" stroke="none"/></Icon>,
  drag: (p) => <Icon {...p}><circle cx="9" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.2" fill="currentColor" stroke="none"/></Icon>,
  edit: (p) => <Icon {...p}><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></Icon>,
  robot: (p) => <Icon {...p}><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 4v4M8 14h.01M16 14h.01M9 18h6M2 13v3M22 13v3"/></Icon>,
  home: (p) => <Icon {...p}><path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2h-4v-7h-6v7H5a2 2 0 0 1-2-2z"/></Icon>,
  refresh: (p) => <Icon {...p}><path d="M21 12a9 9 0 0 1-15 6.7L3 16M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M3 21v-5h5"/></Icon>,
  upload: (p) => <Icon {...p}><path d="M12 15V3M7 8l5-5 5 5M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/></Icon>,
  database: (p) => <Icon {...p}><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></Icon>,
  lock: (p) => <Icon {...p}><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></Icon>,
  palette: (p) => <Icon {...p}><path d="M12 3a9 9 0 1 0 0 18 3 3 0 0 0 2.5-4.6 1.5 1.5 0 0 1 1.3-2.3H18a3 3 0 0 0 3-3 9 9 0 0 0-9-8z"/><circle cx="7.5" cy="10.5" r="1"/><circle cx="12" cy="7.5" r="1"/><circle cx="16.5" cy="10.5" r="1"/></Icon>,
};

// Notus brand mark — pen nib "N" glyph
const NotusLogo = ({ size = 24, color = 'var(--accent)' }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" style={{ color }}>
    <rect x="1" y="1" width="30" height="30" rx="7" fill="currentColor"/>
    <path d="M10 22 V11 L21 21 V10"
          stroke="#FAF9F5" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
    <circle cx="10" cy="22" r="1.6" fill="#FAF9F5"/>
    <circle cx="21" cy="10" r="1.6" fill="#FAF9F5"/>
  </svg>
);

Object.assign(window, { Icon, I, NotusLogo });
