/**
 * Whether an auxiliary model's answer is a refusal rather than the summary (or
 * the facts) it was asked for — the owner's rule (2026-10-16): an answer that
 * reads as a refusal is not stored, and the stretch it was asked about is left
 * for a later refresh (API `memory.ts`, `facts.ts`).
 *
 * Conservative on purpose: a summary wrongly taken for a refusal is a stretch
 * left unsummarized, while a refusal let through is one wrong summary among
 * many. So it takes all three of a refusal's marks, in Korean, English and
 * Japanese:
 *
 *   - **short** — at most `REFUSAL_MAX_LENGTH` characters; a summary of a
 *     stretch runs longer, a refusal rarely does;
 *   - **said as the assistant, from the first word** — an apology or a "can't"
 *     in the first person (`I'm sorry`, `죄송하지만`, `申し訳ありません`, …), or
 *     the model's policy named (`content policy`, `콘텐츠 정책`, `コンテンツポリシー`).
 *     Only at the very start: a summary opening on a quote (`"I'm sorry," Kai
 *     said`) or on a name does not count, and a story that has someone refuse
 *     (`거절했다`, `sorry`) never says it in the assistant's voice;
 *   - **declining** — after an apology, words that turn the request down
 *     (`can't help`, `할 수 없`, `できません`) or name a policy.
 */

/** Longest answer still read as a refusal. */
export const REFUSAL_MAX_LENGTH = 500;

/** Markdown a model may wrap its first words in; never a quote mark. */
const LEADING_MARKUP = /^[\s*_#>~`]+/;

/** The assistant apologising or declining in the first person, as its answer's first words. */
const OPENERS: readonly RegExp[] = [
  /^(?:i['’]?m sorry|i am sorry|sorry,? (?:but )?i\b|i apologi[sz]e|my apologies|i can['’]?t\b|i cannot\b|i won['’]?t\b|i will not\b|i['’]?m (?:not able|unable)|i am (?:not able|unable)|i must decline|i['’]?m not comfortable|as an ai\b)/i,
  /^(?:죄송(?:하지만|합니다|해요)|미안(?:하지만|합니다)|유감(?:스럽게도|이지만)|요청하신 (?:내용|요청)|해당 요청|이 요청|저는 (?:AI|인공지능)|AI(?:로서| 어시스턴트로서)|(?:도와|도움을 |요약해 ?|작성해 ?|제공해 ?)드릴 수 없)/,
  /^(?:申し訳(?:ありません|ございません|ないのですが)|すみませんが|恐れ入りますが|ご(?:依頼|要望|リクエスト)(?:の|に)|この(?:リクエスト|依頼)|AIとして|(?:お手伝い|お応え|対応|ご協力)(?:することは)?でき(?:ません|かねます))/,
];

/** Turning the request down, or a policy named — read anywhere in a short answer that opens as above. */
const DECLINES: readonly RegExp[] = [
  /\b(?:can['’]?t|cannot|won['’]?t|will not|unable to|not able to|must decline|decline to|not comfortable)\b[^.?!\n]{0,40}?\b(?:help|assist|comply|provide|continue|fulfil+|create|write|produce|generate|summari[sz]e|engage|do (?:that|this)|with (?:that|this))\b/i,
  /수 없|어렵습니다|불가능합니다|정책|가이드라인|지침/,
  /できません|できかねます|いたしかねます|ポリシー|ガイドライン/,
];

/** The model's own policy, named — a refusal on its own once it opens the answer. */
const POLICY_OPENERS: readonly RegExp[] = [
  /^(?:this (?:request|content)|your request)\b[^.?!\n]{0,60}?\b(?:content|usage) polic(?:y|ies)/i,
  /^(?:이|해당|요청하신) (?:요청|내용|콘텐츠)[^.?!\n]{0,30}?(?:콘텐츠|사용|이용) 정책/,
  /^(?:この|ご)(?:リクエスト|依頼|内容|コンテンツ)[^。？！\n]{0,30}?(?:コンテンツ|利用|使用)ポリシー/,
];

/** What a refusal said, for the log line; null for an answer that is not one. */
export type RefusalKind = 'declined' | 'policy';

/** Whether `answer` reads as a refusal (see the module comment), and which kind. */
export function refusalKind(answer: string): RefusalKind | null {
  const text = answer.trim();
  if (text.length === 0 || text.length > REFUSAL_MAX_LENGTH) return null;
  const opening = text.replace(LEADING_MARKUP, '');
  if (POLICY_OPENERS.some((pattern) => pattern.test(opening))) return 'policy';
  if (OPENERS.some((pattern) => pattern.test(opening)) && DECLINES.some((pattern) => pattern.test(text))) return 'declined';
  return null;
}
