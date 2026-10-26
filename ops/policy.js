'use strict';
// Ops Terminal command policy: deny-list always, allow-list by default.
// This is a guard rail in front of the real boundary (separate uid, rlimits,
// namespaces when available). It is not a security boundary on its own.

const MAX_COMMAND_LEN = 2000;

// Commands an agent may start in allow-list mode (resolved through a private PATH dir).
const ALLOW = [
  'ls', 'cat', 'echo', 'printf', 'pwd', 'date', 'uname', 'whoami', 'id', 'hostname',
  'head', 'tail', 'wc', 'grep', 'sort', 'uniq', 'cut', 'tr', 'find', 'stat', 'du', 'df',
  'free', 'uptime', 'ps', 'sleep', 'true', 'false', 'seq', 'sha256sum', 'md5sum', 'base64',
  'mkdir', 'touch', 'cp', 'mv', 'rm', 'tee', 'diff', 'basename', 'dirname', 'expr', 'test',
  'nproc', 'yes', 'rev', 'fold', 'nl', 'od', 'xxd', 'gzip', 'gunzip', 'tar', 'jq',
];
// Shell builtins that are harmless as a command word.
const BUILTIN_OK = new Set(['cd', 'echo', 'printf', 'pwd', 'true', 'false', 'test', '[', ':', 'read', 'set', 'unset', 'shift', 'wait', 'exit', 'return',
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'in', '!']);

// Always blocked, in every mode: patterns anywhere in the command text. [regex, reason]
const DENY_TEXT = [
  [/169\.254\.\d+\.\d+|\bmetadata\.(azure|google)|\/metadata\/|168\.63\.129\.16|fd00:ec2::254/i, 'metadata/wireserver endpoint'],
  [/IDENTITY_(ENDPOINT|HEADER)|MSI_(ENDPOINT|SECRET)|:42356\b|\/msi\/token/i, 'managed identity endpoint'],
  [/\/proc\/(\d+|self|thread-self|\*)\/(environ|mem|maps|root|cwd|fd)|\/proc\/1(\/|\b)|\/proc\/kcore|\/proc\/sys\b|\/sys\/(kernel|fs\/cgroup)/i, 'process / kernel internals'],
  [/:\s*\(\s*\)\s*\{/, 'fork bomb'],
  [/\brm\s+(-[a-z]*\s+)*-[a-z]*[rf][a-z]*\s+(\/\s*$|\/\s|\/\*|~|\$HOME)/i, 'recursive delete outside sandbox'],
  [/\/dev\/(tcp|udp)\/|\/dev\/(sd|nvme|vd|xvd|mem|kmem|port)/i, 'raw device / socket'],
  [/\bdd\b.*\bif=\/dev\//i, 'raw disk read'],
  [/(^|[\s;|&])-exec(dir)?\b|(^|\s)-ok(dir)?\b|--to-command|--checkpoint-action|--use-compress-program|--rsh-command/, 'nested command execution'],
  [/\b(PATH|ENV|BASH_ENV|LD_PRELOAD|LD_LIBRARY_PATH)\s*=/, 'environment override'],
];
// Always blocked as a command word (first word of any pipeline segment, basename).
const DENY_WORDS = [
  [['sudo', 'su', 'doas', 'chroot', 'nsenter', 'unshare', 'setsid', 'mount', 'umount', 'insmod', 'modprobe', 'rmmod', 'mkfs', 'fdisk', 'parted', 'swapon', 'sysctl', 'iptables', 'nft', 'ip', 'ifconfig', 'route', 'capsh', 'setcap', 'chown', 'chmod', 'chattr', 'reboot', 'shutdown', 'halt', 'poweroff', 'init', 'systemctl', 'crontab', 'kill', 'killall', 'pkill', 'prlimit', 'ulimit'], 'privileged / system command'],
  [['curl', 'wget', 'nc', 'ncat', 'netcat', 'socat', 'telnet', 'ssh', 'scp', 'sftp', 'rsync', 'ftp', 'ftpget', 'ftpput', 'tftp', 'nslookup', 'dig', 'host', 'ping', 'traceroute', 'whois', 'httpd', 'openssl'], 'network tool'],
  [['busybox', 'toybox', 'node', 'nodejs', 'npm', 'npx', 'python', 'python3', 'perl', 'ruby', 'php', 'lua', 'gcc', 'cc', 'make', 'apk', 'apt', 'apt-get', 'dpkg', 'pip', 'pip3', 'docker', 'kubectl', 'az', 'bash', 'sh', 'ash', 'dash', 'zsh', 'ksh', 'vi', 'vim', 'nano', 'less', 'more', 'script', 'strace', 'gdb'], 'interpreter / package manager / shell'],
  [['eval', 'exec', 'source', '.', 'trap', 'alias', 'command', 'builtin'], 'shell escape builtin'],
  [['xargs', 'awk', 'sed', 'env', 'time', 'nohup', 'timeout', 'nice', 'stdbuf', 'watch', 'flock', 'chpst'], 'command runner'],
];
const DENY_WORD_MAP = new Map(DENY_WORDS.flatMap(([ws, r]) => ws.map(w => [w, r])));

function splitSegments(cmd) {
  // Split on ; | & && || and newlines, outside quotes. Returns array of segment strings.
  const segs = []; let cur = ''; let q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) { cur += c; if (c === q) q = null; else if (c === '\\' && q === '"' && i + 1 < cmd.length) cur += cmd[++i]; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '\\' && i + 1 < cmd.length) { cur += c + cmd[++i]; continue; }
    if (c === '$' && cmd.startsWith('$((', i)) { // arithmetic expansion: keep whole
      const j = cmd.indexOf('))', i + 3); if (j < 0) return null;
      cur += cmd.slice(i, j + 2); i = j + 1; continue;
    }
    if (c === ';' || c === '|' || c === '&' || c === '\n' || c === '(' || c === ')' || c === '{' || c === '}') { segs.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (q) return null; // unbalanced quote
  segs.push(cur);
  return segs.map(s => s.trim()).filter(Boolean);
}

function firstWord(seg) {
  // skip leading VAR=value assignments and redirections
  const toks = seg.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  for (const t of toks) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue;
    if (/^\d*[<>]/.test(t)) continue;
    return t.replace(/^["']|["']$/g, '');
  }
  return '';
}

// Returns { ok: true } or { ok: false, reason }.
function check(command, mode = 'allowlist') {
  if (typeof command !== 'string' || !command.trim()) return { ok: false, reason: 'empty command' };
  if (command.length > MAX_COMMAND_LEN) return { ok: false, reason: `command longer than ${MAX_COMMAND_LEN} chars` };
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(command)) return { ok: false, reason: 'control characters' };
  for (const [re, reason] of DENY_TEXT) if (re.test(command)) return { ok: false, reason: 'deny-list: ' + reason };
  const segs = splitSegments(command);
  if (!segs) return { ok: false, reason: 'unbalanced quotes' };
  const words = segs.map(firstWord).filter(Boolean);
  for (const w of words) {
    const base = w.split('/').pop().replace(/^mkfs\..*/, 'mkfs');
    if (DENY_WORD_MAP.has(base)) return { ok: false, reason: `deny-list: ${DENY_WORD_MAP.get(base)} (${base.slice(0, 40)})` };
  }
  if (mode === 'denylist') return { ok: true };
  if (/`|\$\((?!\()|<\(|>\(|\$\{[^}]*[:#%\/!]/.test(command)) return { ok: false, reason: 'allow-list: command/process substitution not allowed' };
  if (/\$[A-Za-z_{]/.test(words.join(' '))) return { ok: false, reason: 'allow-list: variables are not allowed as commands' };
  for (const w of words) {
    if (w.includes('/')) return { ok: false, reason: `allow-list: paths are not allowed as commands (${w.slice(0, 40)})` };
    if (!ALLOW.includes(w) && !BUILTIN_OK.has(w)) return { ok: false, reason: `allow-list: '${w.slice(0, 40)}' is not an allowed command` };
  }
  return { ok: true };
}

// Redact anything that looks like a credential before it is logged.
const SECRET_RE = /(nvapi-[A-Za-z0-9_-]+|sk_(live|test)_[A-Za-z0-9]+|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.-]+|sig=[^&\s'"]+|(?:password|passwd|token|secret|api[_-]?key)\s*[=:]\s*\S+|Bearer\s+\S+|-----BEGIN[^-]+PRIVATE KEY-----)/gi;
const redact = s => String(s).replace(SECRET_RE, '[REDACTED]');

module.exports = { check, redact, ALLOW, MAX_COMMAND_LEN };
