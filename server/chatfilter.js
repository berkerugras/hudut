// Masks common English and Turkish swear words and slurs in chat. It is a coarse filter, not a
// guarantee: players can still mute each other in the client.

// Matched at the start of a word, after lowercasing and undoing simple letter swaps (4 -> a ...).
// These are also matched after squeezing repeated letters ("fuuuck" -> "fuck").
const STEMS = [
  'fuck', 'shit', 'bitch', 'cunt', 'ashole', 'bastard', 'fag', 'retard', 'whore', 'slut', 'dick', 'pusy',
  'orospu', 'siktir', 'sikerim', 'sikeyim', 'sikik', 'sikiş', 'amına', 'amina', 'amcık', 'amcik',
  'yarak', 'ibne', 'kahpe', 'pezevenk', 'gavat', 'şerefsiz', 'serefsiz', 'kaltak', 'puşt', 'taşak', 'yavşak', 'yavsak',
];
// Matched at the start of a word without squeezing letters (squeezing would hit innocent words, e.g. the country Niger).
const RAW_STEMS = ['nigger', 'nigga', 'faggot'];
// Only whole words (as prefixes they would hit normal words: "götür", "sikke", "pic").
const WHOLE = new Set(['amk', 'aq', 'amq', 'oç', 'piç', 'göt', 'sik', 'mq']);

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };

function isBad(token) {
  const raw = token.toLocaleLowerCase('tr').replace(/[013457@$]/g, (ch) => LEET[ch]);
  if (WHOLE.has(raw)) return true;
  if (RAW_STEMS.some((s) => raw.startsWith(s))) return true;
  const squeezed = raw.replace(/(.)\1+/g, '$1');
  return STEMS.some((s) => raw.startsWith(s) || squeezed.startsWith(s));
}

export function maskProfanity(text) {
  return text.replace(/[\p{L}\p{N}@$]+/gu, (token) => (isBad(token) ? '*'.repeat(token.length) : token));
}
