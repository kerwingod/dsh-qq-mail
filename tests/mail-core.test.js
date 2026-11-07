/**
 * 邮件核心链路测试：收发 / 查信 / 链接提取（用 Mock 适配器，零网络依赖）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockMailAdapter } from '../src/mail/mock.js';
import { extractLinks, mailToChatText, chatToMailContent } from '../src/schema.js';

test('收信：seed 后 listMessages 能读到', async () => {
  const m = new MockMailAdapter({ account: 'me@qq.com' });
  await m.connect();
  m.seed({ from: [{ address: 'a@qq.com' }], subject: '你好', text: '正文内容' });
  const list = await m.listMessages();
  assert.equal(list.length, 1);
  assert.equal(list[0].subject, '你好');
});

test('发信：sendMessage 进入已发件箱', async () => {
  const m = new MockMailAdapter({ account: 'me@qq.com' });
  await m.connect();
  const sent = await m.sendMessage({
    to: ['friend@qq.com'],
    subject: '测试',
    text: '这是一封测试邮件',
  });
  assert.equal(sent.direction, 'outbound');
  assert.equal(m.sentBox().length, 1);
  assert.equal(m.sentBox()[0].to[0].address, 'friend@qq.com');
});

test('未读过滤：markSeen 后 unreadOnly 不再返回', async () => {
  const m = new MockMailAdapter({ account: 'me@qq.com' });
  await m.connect();
  m.seed({ id: 'x1', from: [{ address: 'a@qq.com' }], subject: 's1', text: 't1' });
  assert.equal((await m.listMessages({ unreadOnly: true })).length, 1);
  await m.markSeen('x1');
  assert.equal((await m.listMessages({ unreadOnly: true })).length, 0);
});

test('邮件里的链接能被提取（HTML 原样保留、链接可跳转）', () => {
  const html = '<p>看这里 <a href="https://example.com/a">链接A</a> 和 <a href="https://example.com/b">B</a></p>';
  const text = '纯文本 https://example.com/c 结尾。';
  const links = extractLinks({ html, text });
  assert.ok(links.includes('https://example.com/a'));
  assert.ok(links.includes('https://example.com/b'));
  assert.ok(links.includes('https://example.com/c'));
});

test('邮件转会话文本：链接以可点击形式列出', () => {
  const mail = {
    id: 'm1',
    from: [{ address: 'a@qq.com' }],
    subject: '标题',
    text: '点 https://example.com 查看',
    html: '',
    date: new Date().toISOString(),
    links: ['https://example.com'],
  };
  const chat = mailToChatText(mail);
  assert.match(chat, /https:\/\/example\.com/);
});

test('会话内容转邮件：链接在 HTML 中以 <a> 呈现（保证可跳转）', () => {
  const chat = { sessionId: 's1', role: 'user', text: '参考 https://example.com/x', date: new Date().toISOString(), links: ['https://example.com/x'] };
  const mail = chatToMailContent(chat);
  assert.match(mail.html, /<a[^>]+href="https:\/\/example\.com\/x"/);
});
