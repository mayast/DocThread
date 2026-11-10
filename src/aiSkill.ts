export interface ResolvedSkill {
  name: string;
  body: string;
}

export interface SkillSource {
  skill: ResolvedSkill;
  source: string;
}

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;

function basename(source: string): string {
  const clean = source.split(/[?#]/, 1)[0].replace(/[\\\/]+$/, '');
  const last = clean.split(/[\\/]/).filter(Boolean).pop() || 'Skill';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

function withoutExtension(name: string): string {
  return name.replace(/\.(?:md|markdown|txt|text)$/i, '');
}

function titleCaseSlug(value: string): string {
  const words = withoutExtension(value)
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!words) return 'Skill';
  return words.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function deriveSkillName(body: string, source = 'Skill'): string {
  const frontmatter = body.match(FRONTMATTER_RE)?.[1] || '';
  const nameLine = frontmatter
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*name\s*:\s*(.+?)\s*$/i)?.[1])
    .find((value): value is string => Boolean(value?.trim()));
  if (nameLine) return nameLine.replace(/^['"]|['"]$/g, '').trim();

  const heading = body.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim();
  if (heading) return heading;

  return titleCaseSlug(basename(source));
}

export function resolveSkillFromText(body: string, source = 'Skill'): SkillSource | null {
  const text = body || '';
  if (!text.trim()) return null;
  return {
    skill: {
      name: deriveSkillName(text, source),
      body: text,
    },
    source,
  };
}

export function parseSkillPaths(value: string | undefined): string[] {
  return (value || '')
    .split(/[\n,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
