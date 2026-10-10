export type AcceptanceParty = { key: string; name: string; nodeType: string };

export type AcceptanceVerdict =
  | { kind: 'pass' }
  | { kind: 'unclear' }
  | { kind: 'reject'; items: Array<{ party: AcceptanceParty; reason: string }> };

export function acceptanceLimit(value: unknown): number {
  const count = Number(value);
  return Number.isInteger(count) && count >= 1 ? count : 3;
}

export function acceptanceRuleLines(value: unknown): string[] {
  const source = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\r?\n/) : [];
  return source.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
}

function cleanLabel(value: string): string {
  return value.trim().replace(/^["「『]|["」』]$/g, '').trim();
}

export function parseAcceptanceVerdict(text: string, parties: readonly AcceptanceParty[]): AcceptanceVerdict {
  const body = text.replace(/\r/g, '').trim();
  if (!body) return { kind: 'unclear' };
  const failed = body.includes('不合格');
  const passed = /合格/.test(body.split('不合格').join(''));
  if (!failed && passed) return { kind: 'pass' };
  if (!failed) return { kind: 'unclear' };

  const items: Array<{ party: AcceptanceParty; reason: string }> = [];
  for (const block of body.split(/\n(?=\s*退回\s*[:：])/)) {
    const match = block.match(/退回\s*[:：]\s*(.+)/);
    if (!match) continue;
    const label = cleanLabel((match[1].split('\n')[0] ?? '').trim());
    const party = parties.find((item) => item.name === label || item.key === label);
    if (!party || items.some((item) => item.party.key === party.key)) continue;
    const reasonMatch = block.match(/原因\s*[:：]\s*([\s\S]*)/);
    items.push({ party, reason: (reasonMatch?.[1] ?? '').trim() || body });
  }
  if (items.length === 0 && parties.length === 1) {
    const reasonMatch = body.match(/原因\s*[:：]\s*([\s\S]*)/);
    return { kind: 'reject', items: [{ party: parties[0], reason: (reasonMatch?.[1] ?? body).trim() }] };
  }
  if (items.length === 0) return { kind: 'unclear' };
  return { kind: 'reject', items };
}
