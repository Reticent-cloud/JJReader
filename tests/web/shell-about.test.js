// Task 16：关于面板入口与 .md 关联状态提示。
// 契约：工具条「关于」按钮点击 → post('openAbout')；宿主 assocState 消息更新按钮 title，
// 让用户不打开关于面板也能看出当前是否为默认 .md 程序。

const mounted = [];

function createRoot() {
  const root = document.createElement('div');
  root.id = 'app';
  document.body.append(root);
  return root;
}

function mount() {
  const root = createRoot();
  const posted = [];
  const shell = JJ.mountShell({ root, post: (type, payload) => posted.push({ type, payload }) });
  mounted.push(shell);
  return { root, shell, posted };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  for (const shell of mounted.splice(0)) {
    if (shell && typeof shell.destroy === 'function') {
      shell.destroy();
    }
  }
  document.body.innerHTML = '';
});

it('工具条「关于」按钮发送 openAbout', () => {
  const { root, posted } = mount();
  const about = root.querySelector('#toolbar #about');

  expect(about).toBeTruthy();
  expect(about.textContent).toBe('关于');
  expect(about.title).toContain('关于');

  about.click();

  expect(posted.filter((message) => message.type === 'openAbout')).toHaveLength(1);
});

it('assocState 更新「关于」按钮 title：默认程序 / 未设为默认', () => {
  const { root, shell } = mount();
  const about = root.querySelector('#toolbar #about');

  shell.onMessage({ type: 'assocState', payload: { registered: true, isDefault: true } });
  expect(about.title).toBe('默认 .md 程序');

  shell.onMessage({ type: 'assocState', payload: { registered: true, isDefault: false } });
  expect(about.title).toBe('尚未设为默认 .md 程序（可在关于中设置）');

  // 未注册同样是「未设为默认」，仍可从关于面板去设置
  shell.onMessage({ type: 'assocState', payload: { registered: false, isDefault: false } });
  expect(about.title).toBe('尚未设为默认 .md 程序（可在关于中设置）');
});
