/**
 * A title from a file name, as Directus gives uploads one: a port of @directus/format-title 12.1.2
 * (MIT, Monospace Inc.): `my-holiday_photo2024` → `My Holiday Photo2024`, with APA title-case
 * rules for short words and known acronyms.
 */

const ACRONYMS = [
  '2D', '3D', '4WD', 'A2O', 'AI', 'API', 'BIOS', 'CC', 'CCTV', 'CCV', 'CD', 'CD-ROM', 'CIA', 'CMS', 'COBOL', 'CSS', 'CSV',
  'CV', 'DB', 'DIY', 'DNA', 'DVD', 'E3', 'EIN', 'ESPN', 'FAQ', 'FAQs', 'FBI', 'FORTRAN', 'FPS', 'FTP', 'HTML', 'HTTP',
  'HTTPS', 'ID', 'IP', 'ISO', 'JS', 'JSON', 'LASER', 'M2A', 'M2M', 'M2MM', 'M2O', 'MMORPG', 'NAFTA', 'NASA', 'NDA', 'O2A',
  'O2M', 'PDF', 'PHP', 'POP', 'RAM', 'RNGR', 'ROM', 'RPG', 'RTFM', 'RTS', 'SCUBA', 'SDK', 'SITCOM', 'SKU', 'SMTP', 'SQL',
  'SSL', 'SSN', 'SWAT', 'TBS', 'TLS', 'TNA', 'TS', 'TTL', 'TV', 'UI', 'URL', 'USB', 'UWP', 'VIP', 'W3C', 'WWE', 'WWF',
  'WWW', 'WYSIWYG',
];

const ARTICLES = ['a', 'an', 'the'];

const CONJUNCTIONS = [
  'and', 'that', 'but', 'or', 'as', 'if', 'when', 'than', 'because', 'while', 'where', 'after', 'so', 'though', 'since',
  'until', 'whether', 'before', 'although', 'nor', 'like', 'once', 'unless', 'now', 'except',
];

const PREPOSITIONS = [
  'about', 'above', 'across', 'after', 'against', 'along', 'among', 'around', 'at', 'because of', 'before', 'behind',
  'below', 'beneath', 'beside', 'besides', 'between', 'beyond', 'but', 'by', 'concerning', 'despite', 'down', 'during',
  'except', 'excepting', 'for', 'from', 'in', 'in front of', 'inside', 'in spite of', 'instead of', 'into', 'like', 'near',
  'of', 'off', 'on', 'onto', 'out', 'outside', 'over', 'past', 'regarding', 'since', 'through', 'throughout', 'to',
  'toward', 'under', 'underneath', 'until', 'up', 'upon', 'up to', 'with', 'within', 'without', 'with regard to',
  'with respect to',
];

const SPECIAL_CASE = [
  '2FA', '4K', '5K', '8K', 'AGI', 'BI', 'ChatGPT', 'CTA', 'DateTime', 'FMS', 'GitHub', 'GPT', 'HD', 'IBMid', 'IDs', 'iMac',
  'IMAX', 'iOS', 'iPad', 'iPhone', 'iPod', 'LDAP', 'LinkedIn', 'LLM', 'macOS', 'McDonalds', 'MCP', 'ML', 'MySQL', 'NLG',
  'NLP', 'NLU', 'OpenAI', 'PDFs', 'PIM', 'PEFT', 'pH', 'PostgreSQL', 'SEO', 'TTS', 'UHD', 'UUID', 'XSS', 'YouTube',
];

const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.substring(1);

const decamelize = (s: string) =>
  s
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z\d]+)/g, '$1_$2')
    .toLowerCase();

function special(word: string, index: number, words: string[]): string {
  const lower = word.toLowerCase();
  const upper = word.toUpperCase();
  for (const s of SPECIAL_CASE) if (s.toLowerCase() === lower) return s;
  if (ACRONYMS.includes(upper)) return upper;
  if (index === 0 || index === words.length - 1 || word.length >= 4) return word;
  if (PREPOSITIONS.includes(lower) || CONJUNCTIONS.includes(lower) || ARTICLES.includes(lower)) return lower;
  return word;
}

export function formatTitle(title: string): string {
  return decamelize(title)
    .split(/\s|-|_/g)
    .map(capitalize)
    .map(special)
    .reduce((acc, s) => `${acc} ${s}`);
}
