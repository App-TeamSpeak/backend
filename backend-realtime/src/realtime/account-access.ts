import { watchAccountDeletion } from '../config/firebase';
import { AccountAuthorizationError, type AuthorizationCode, authorizationTimeoutMs } from '../services/account-state.service';

export interface AccessSession {
  block(code: AuthorizationCode): void;
  disconnect(): void;
}
interface Member {
  session: AccessSession;
  ready: Promise<() => void>;
  resolve(release: () => void): void;
  reject(error: AccountAuthorizationError): void;
  detach(): void;
}
interface Entry {
  members: Map<AccessSession, Member>;
  state: 'initializing' | 'active' | 'closed';
  stop?: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

// Instance-local ownership. Entry identity prevents callbacks from old generations.
export function createAccountAccess() {
  const entries = new Map<string, Entry>();
  let closing = false;
  function dispose(uid: string, entry: Entry) {
    if (entry.state === 'closed') return;
    entry.state = 'closed';
    clearTimeout(entry.timer);
    if (entries.get(uid) === entry) entries.delete(uid);
    try { entry.stop?.(); }
    catch { console.error({ event: 'account_observer_cleanup_failed', code: 'AUTHORIZATION_UNAVAILABLE' }); }
  }
  function deny(uid: string, entry: Entry, code: AuthorizationCode) {
    if (entries.get(uid) !== entry || entry.state === 'closed') return;
    const members = [...entry.members.values()];
    // Block all members before triggering any disconnection or promise continuation.
    for (const member of members) member.session.block(code);
    dispose(uid, entry);
    for (const member of members) {
      member.reject(new AccountAuthorizationError(code));
      member.detach();
      member.session.disconnect();
    }
    entry.members.clear();
  }
  function attach(uid: string, session: AccessSession, signal: AbortSignal): Promise<() => void> {
    if (closing || signal.aborted) return Promise.reject(new AccountAuthorizationError('AUTHORIZATION_UNAVAILABLE'));
    let entry = entries.get(uid);
    const fresh = !entry;
    if (!entry) { entry = { members: new Map(), state: 'initializing' }; entries.set(uid, entry); }
    const current = entry;
    const existing = current.members.get(session);
    if (existing) return existing.ready;
    let resolve!: Member['resolve']; let reject!: Member['reject'];
    const ready = new Promise<() => void>((done, fail) => { resolve = done; reject = fail; });
    const release = () => {
      const member = current.members.get(session);
      if (!member) return;
      member.detach(); current.members.delete(session);
      member.reject(new AccountAuthorizationError('AUTHORIZATION_UNAVAILABLE'));
      if (!current.members.size) dispose(uid, current);
    };
    const member: Member = { session, ready, resolve, reject, detach: () => signal.removeEventListener('abort', release) };
    current.members.set(session, member);
    signal.addEventListener('abort', release, { once: true });
    if (current.state === 'active') resolve(release);
    if (fresh) {
      current.timer = setTimeout(() => deny(uid, current, 'AUTHORIZATION_UNAVAILABLE'), authorizationTimeoutMs);
      try {
        const stop = watchAccountDeletion(uid, (exists) => {
          if (closing || entries.get(uid) !== current || current.state === 'closed') return;
          if (exists) { deny(uid, current, 'ACCOUNT_UNAVAILABLE'); return; }
          current.state = 'active'; clearTimeout(current.timer);
          for (const [registered, waiting] of current.members) {
            waiting.resolve(() => {
              const item = current.members.get(registered);
              if (!item) return;
              item.detach(); current.members.delete(registered);
              if (!current.members.size) dispose(uid, current);
            });
          }
        }, (error) => {
          if (entries.get(uid) !== current || current.state === 'closed') return;
          console.error({ event: 'account_observer_failed', code: error.code });
          deny(uid, current, 'AUTHORIZATION_UNAVAILABLE');
        });
        if (current.state === 'closed') stop();
        else current.stop = stop;
      } catch {
        console.error({ event: 'account_observer_start_failed', code: 'AUTHORIZATION_UNAVAILABLE' });
        deny(uid, current, 'AUTHORIZATION_UNAVAILABLE');
      }
    }
    return ready;
  }
  function close() {
    if (closing) return;
    closing = true;
    for (const [uid, entry] of [...entries]) deny(uid, entry, 'AUTHORIZATION_UNAVAILABLE');
  }
  return { attach, close, getState: () => ({ closing, observers: entries.size, sessions: [...entries.values()].reduce((sum, entry) => sum + entry.members.size, 0) }) };
}
