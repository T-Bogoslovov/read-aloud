/**
 * Text normalization and phoneme handling for Kokoro, ported from the kokoro-js reference
 * implementation (MIT, Xenova) so output matches what the model was trained to expect.
 */

export type KokoroLang = 'a' | 'b' | 'e' | 'f' | 'h' | 'i' | 'j' | 'p' | 'z';

/** espeak-ng language codes for each Kokoro voice prefix. */
export const ESPEAK_LANG: Record<KokoroLang, string> = {
  a: 'en-us', b: 'en', e: 'es', f: 'fr-fr', h: 'hi', i: 'it', j: 'ja', p: 'pt-br', z: 'cmn',
};

/**
 * Language for a voice id. The bundled phonemizer only ships English espeak data, so every
 * non-English voice falls back to American English phonemization.
 */
export function langForVoice(voice: string): KokoroLang {
  return voice[0] === 'b' ? 'b' : 'a';
}

function splitNum(match: string): string {
  if (match.includes('.')) return match;
  if (match.includes(':')) {
    const [h, m] = match.split(':').map(Number);
    if (m === 0) return `${h} o'clock`;
    if (m < 10) return `${h} oh ${m}`;
    return `${h} ${m}`;
  }
  const year = parseInt(match.slice(0, 4), 10);
  if (year < 1100 || year % 1000 < 10) return match;
  const left = match.slice(0, 2);
  const right = parseInt(match.slice(2, 4), 10);
  const suffix = match.endsWith('s') ? 's' : '';
  if (year % 1000 >= 100 && year % 1000 <= 999) {
    if (right === 0) return `${left} hundred${suffix}`;
    if (right < 10) return `${left} oh ${right}${suffix}`;
  }
  return `${left} ${right}${suffix}`;
}

function flipMoney(match: string): string {
  const bill = match[0] === '$' ? 'dollar' : 'pound';
  if (isNaN(Number(match.slice(1)))) return `${match.slice(1)} ${bill}s`;
  if (!match.includes('.')) {
    const s = match.slice(1) === '1' ? '' : 's';
    return `${match.slice(1)} ${bill}${s}`;
  }
  const [b, c] = match.slice(1).split('.');
  const cents = parseInt(c.padEnd(2, '0'), 10);
  const coins = match[0] === '$' ? (cents === 1 ? 'cent' : 'cents') : cents === 1 ? 'penny' : 'pence';
  return `${b} ${bill}${b === '1' ? '' : 's'} and ${cents} ${coins}`;
}

function pointNum(match: string): string {
  const [a, b] = match.split('.');
  return `${a} point ${b.split('').join(' ')}`;
}

/** English text normalization (numbers, money, titles) as done by kokoro-js. */
export function normalizeEnglish(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/«/g, '“')
    .replace(/»/g, '”')
    .replace(/[“”]/g, '"')
    .replace(/\(/g, '«')
    .replace(/\)/g, '»')
    .replace(/、/g, ', ')
    .replace(/。/g, '. ')
    .replace(/！/g, '! ')
    .replace(/，/g, ', ')
    .replace(/：/g, ': ')
    .replace(/；/g, '; ')
    .replace(/？/g, '? ')
    .replace(/[^\S \n]/g, ' ')
    .replace(/  +/g, ' ')
    .replace(/(?<=\n) +(?=\n)/g, '')
    .replace(/\bD[Rr]\.(?= [A-Z])/g, 'Doctor')
    .replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, 'Mister')
    .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, 'Miss')
    .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, 'Mrs')
    .replace(/\betc\.(?! [A-Z])/gi, 'etc')
    .replace(/\b(y)eah?\b/gi, "$1e'a")
    .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, splitNum)
    .replace(/(?<=\d),(?=\d)/g, '')
    .replace(/[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi, flipMoney)
    .replace(/\d*\.\d+/g, pointNum)
    .replace(/(?<=\d)-(?=\d)/g, ' to ')
    .replace(/(?<=\d)S/g, ' S')
    .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
    .replace(/(?<=X')S\b/g, 's')
    .replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (m) => m.replace(/\./g, '-'))
    .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, '-')
    .trim();
}

const PUNCTUATION = ';:,.!?¡¿—…"«»“”(){}[]';
const PUNCTUATION_RE = new RegExp(`(\\s*[${PUNCTUATION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]+\\s*)+`, 'g');

interface Part { punct: boolean; text: string }

function splitKeepingPunctuation(text: string): Part[] {
  const parts: Part[] = [];
  let last = 0;
  for (const m of text.matchAll(PUNCTUATION_RE)) {
    const idx = m.index ?? 0;
    if (last < idx) parts.push({ punct: false, text: text.slice(last, idx) });
    if (m[0].length > 0) parts.push({ punct: true, text: m[0] });
    last = idx + m[0].length;
  }
  if (last < text.length) parts.push({ punct: false, text: text.slice(last) });
  return parts;
}

export type PhonemizeFn = (text: string, language: string) => Promise<string[]>;

/** Convert text to the phoneme string Kokoro expects. */
export async function textToPhonemes(text: string, lang: KokoroLang, phonemize: PhonemizeFn): Promise<string> {
  const english = lang === 'a' || lang === 'b';
  const normalized = english ? normalizeEnglish(text) : text.trim();
  const parts = splitKeepingPunctuation(normalized);
  const language = ESPEAK_LANG[lang];
  const phonemized = await Promise.all(
    parts.map(async (p) => (p.punct ? p.text : (await phonemize(p.text, language)).join(' '))),
  );
  let ps = phonemized
    .join('')
    .replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ')
    .replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ')
    .replace(/ʲ/g, 'j')
    .replace(/r/g, 'ɹ')
    .replace(/x/g, 'k')
    .replace(/ɬ/g, 'l')
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ')
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, 'z');
  if (lang === 'a') ps = ps.replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di');
  return ps.trim();
}

/** Map phoneme characters to token ids, dropping anything not in the vocabulary. */
export function tokenizePhonemes(phonemes: string, vocab: Record<string, number>): number[] {
  const ids: number[] = [];
  for (const ch of phonemes) {
    const id = vocab[ch];
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

/** Maximum phoneme tokens the model accepts in one pass (excluding the two boundary pads). */
export const MAX_TOKENS = 500;

/** Split a long phoneme string into chunks whose token count stays under the model limit. */
export function chunkPhonemes(phonemes: string, vocab: Record<string, number>, max = MAX_TOKENS): string[] {
  if (tokenizePhonemes(phonemes, vocab).length <= max) return [phonemes];
  const chunks: string[] = [];
  let current = '';
  // Prefer splitting at punctuation, then spaces.
  const pieces = phonemes.split(/(?<=[;:,.!?…])\s+/);
  const pushPiece = (piece: string) => {
    const candidate = current ? `${current} ${piece}` : piece;
    if (tokenizePhonemes(candidate, vocab).length <= max) { current = candidate; return; }
    if (current) { chunks.push(current); current = ''; }
    if (tokenizePhonemes(piece, vocab).length <= max) { current = piece; return; }
    // Hard split on spaces.
    let part = '';
    for (const word of piece.split(' ')) {
      const cand = part ? `${part} ${word}` : word;
      if (tokenizePhonemes(cand, vocab).length <= max) part = cand;
      else { if (part) chunks.push(part); part = word; }
    }
    current = part;
  };
  for (const piece of pieces) pushPiece(piece);
  if (current) chunks.push(current);
  return chunks;
}
