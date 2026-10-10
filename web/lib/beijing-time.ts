const BEIJING = 'Asia/Shanghai';

function parts(value: string | number | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone: BEIJING,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) => formatted.find((part) => part.type === type)?.value ?? '00';
  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour: pick('hour') === '24' ? '00' : pick('hour'),
    minute: pick('minute'),
    second: pick('second'),
  };
}

export function beijingDateTime(value?: string | number | Date | null): string {
  if (value === undefined || value === null || value === '') return '—';
  const clock = parts(value);
  if (!clock) return '—';
  return `${clock.year}-${clock.month}-${clock.day} ${clock.hour}:${clock.minute}:${clock.second}`;
}

export function beijingClock(value?: string | number | Date | null): string {
  if (value === undefined || value === null || value === '') return '--:--:--';
  const clock = parts(value);
  if (!clock) return '--:--:--';
  return `${clock.hour}:${clock.minute}:${clock.second}`;
}
