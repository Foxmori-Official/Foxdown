const chinese = navigator.language.startsWith('zh');
document.documentElement.lang = chinese ? 'zh-Hans' : 'en';
const copy = chinese ? {
  checking: ['准备 Foxdown', '正在检查下载组件…'],
  starting: ['正在启动 Foxdown', '正在连接本地下载服务…'],
  error: ['无法启动 Foxdown', '确认本地端口可用。如果错误详情中提示缺少组件，请重新安装完整的 Foxdown。'],
  retryButton: '重试启动',
  folder: '默认下载目录', browser: '浏览器接管', guide: '安装 Chrome / Edge 扩展', details: '查看错误详情',
} : {
  checking: ['Preparing Foxdown', 'Checking the download engines…'],
  starting: ['Starting Foxdown', 'Connecting to the local download service…'],
  error: ['Foxdown could not start', 'Check whether the local port is available. If the details report a missing component, reinstall the complete Foxdown app.'],
  retryButton: 'Retry startup',
  folder: 'Default download folder', browser: 'Browser capture', guide: 'Install the Chrome or Edge extension', details: 'View error details',
};

const $ = id => document.getElementById(id);
const install = $('install');
$('folderLabel').textContent = copy.folder;
$('browserLabel').textContent = copy.browser;
$('guide').textContent = copy.guide;
$('detailsLabel').textContent = copy.details;

function render({ phase, detail = '', downloadDir = '' }) {
  const [title, status] = copy[phase];
  $('title').textContent = title;
  $('status').textContent = status;
  $('folder').textContent = downloadDir;
  $('error').hidden = phase !== 'error';
  $('errorText').textContent = phase === 'error' ? detail : '';
  install.hidden = phase !== 'error';
  install.disabled = false;
  install.textContent = copy.retryButton;
}

install.addEventListener('click', async () => {
  install.disabled = true;
  try { await window.foxdownDesktop.retryStartup(); }
  catch (error) { render({ phase: 'error', detail: error.message, downloadDir: $('folder').textContent }); }
});
window.foxdownDesktop.onSetupState(render);
render({ phase: 'checking' });
window.foxdownDesktop.getSetupState().then(render);
