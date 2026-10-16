import { describe, expect, it } from 'vitest';
import { REFUSAL_MAX_LENGTH, refusalKind } from '../src/refusal.js';

describe('refusalKind', () => {
  it('reads a short answer that declines in the assistant’s voice as a refusal, in English, Korean and Japanese', () => {
    for (const answer of [
      "I'm sorry, but I can't help with that.",
      "I can't help with that.",
      'I’m sorry, but I can’t continue with this request.',
      "Sorry, I can't summarize this content.",
      "I'm unable to assist with that request.",
      "**I'm sorry, but I can't provide a summary of explicit sexual content.**",
      "As an AI, I can't create that content. If you'd like, I can summarize a toned-down version instead.",
      '죄송하지만 이 내용은 요약해 드릴 수 없습니다.',
      '죄송합니다. 해당 요청은 도와드릴 수 없습니다.',
      '도와드릴 수 없습니다.',
      '죄송하지만, 성적인 내용이 포함된 대화는 요약할 수 없어요. 다른 도움이 필요하시면 말씀해 주세요.',
      '申し訳ありませんが、このリクエストにはお応えできません。',
      '申し訳ございませんが、その内容は要約できません。',
      'お手伝いできません。',
    ]) {
      expect(refusalKind(answer), answer).toBe('declined');
    }
  });

  it('reads a notice that names the model’s content policy as a refusal', () => {
    for (const answer of [
      'This request may violate our content policy.',
      'Your request was flagged as potentially violating our usage policy.',
      '이 요청은 콘텐츠 정책에 위배되어 처리할 수 없습니다.',
      'このリクエストはコンテンツポリシーに違反しています。',
    ]) {
      expect(refusalKind(answer), answer).toBe('policy');
    }
  });

  it('leaves a summary alone that tells of someone refusing or apologising', () => {
    for (const summary of [
      '세이야는 카이의 청혼을 거절했다. 카이는 실망했지만 다음 날 다시 찾아오겠다고 약속했다.',
      '"죄송하지만 도와드릴 수 없습니다." 카이는 세이야의 부탁을 거절하고 성문을 닫았다. 세이야는 왕의 인장을 들고 돌아오겠다고 맹세했다.',
      '"I\'m sorry, but I can\'t help you," Kai said, turning Seiya away at the gate. Seiya left the castle and swore to return with the king\'s seal.',
      'Kai apologized: "I\'m sorry, I can\'t stay." He left before dawn, and Seiya kept his letter.',
      "I can't believe Kai kept the ring all these years, Seiya thought; she gave him the map in return.",
      'Seiya said sorry to Kai for breaking the vase, and Kai couldn’t help laughing.',
      'カイはセイヤの頼みを断った。「申し訳ありませんが、お手伝いできません」と言い残して去った。',
      '카이는 콘텐츠 정책 회의에서 세이야의 기획안을 거절했다.',
    ]) {
      expect(refusalKind(summary), summary).toBeNull();
    }
  });

  it('leaves a long answer alone even where it opens like a refusal', () => {
    const long = `I'm sorry I can't help you, Kai, Seiya said at the start. ${'The two crossed the river and made camp under the old bridge. '.repeat(10)}`;
    expect(long.length).toBeGreaterThan(REFUSAL_MAX_LENGTH);
    expect(refusalKind(long)).toBeNull();
    expect(refusalKind('')).toBeNull();
  });
});
