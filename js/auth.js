/* ============================================================
   auth.js — 클라이언트 측 인증 관리
   
   - 로그인/로그아웃
   - 세션 체크
   - 권한 기반 UI 전환
   ============================================================ */

const Auth = (() => {
  let _currentUser = null;

  /** 로그인 시도 */
  async function login(userId, password) {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, password }),
    });
    const data = await res.json();
    if (data.success) {
      _currentUser = data.user;
      localStorage.setItem('ad_session', data.sessionId);
      return { success: true, user: data.user };
    }
    return { success: false, error: data.error };
  }

  /** 로그아웃 */
  async function logout() {
    const sid = localStorage.getItem('ad_session');
    if (sid) {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sid }),
      });
    }
    _currentUser = null;
    localStorage.removeItem('ad_session');
  }

  /** 세션 확인 */
  async function checkSession() {
    const sid = localStorage.getItem('ad_session');
    if (!sid) return null;
    try {
      const res = await fetch('/api/auth/session', {
        headers: { 'X-Session-Id': sid },
      });
      const data = await res.json();
      if (data.success) {
        _currentUser = data.user;
        return data.user;
      }
    } catch (e) { /* ignore */ }
    localStorage.removeItem('ad_session');
    _currentUser = null;
    return null;
  }

  /** 현재 사용자 */
  function currentUser() { return _currentUser; }

  /** 팀 목록 조회 (Master용) */
  async function getTeams() {
    const sid = localStorage.getItem('ad_session');
    const res = await fetch('/api/auth/teams', {
      headers: { 'X-Session-Id': sid },
    });
    return res.json();
  }

  /** 사용자 목록 조회 (Master용) */
  async function getUsers() {
    const sid = localStorage.getItem('ad_session');
    const res = await fetch('/api/auth/users', {
      headers: { 'X-Session-Id': sid },
    });
    return res.json();
  }

  /** 사용자 생성 (Master용) */
  async function createUser(userData) {
    const sid = localStorage.getItem('ad_session');
    const res = await fetch('/api/auth/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': sid },
      body: JSON.stringify(userData),
    });
    return res.json();
  }

  /** 사용자 삭제 (Master용) */
  async function deleteUser(userId) {
    const sid = localStorage.getItem('ad_session');
    const res = await fetch(`/api/auth/users/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
      headers: { 'X-Session-Id': sid },
    });
    return res.json();
  }

  /** 사용자 수정 (Master용) */
  async function updateUser(userId, updates) {
    const sid = localStorage.getItem('ad_session');
    const res = await fetch(`/api/auth/users/${encodeURIComponent(userId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': sid },
      body: JSON.stringify(updates),
    });
    return res.json();
  }

  /** 팀 생성 (Master용) */
  async function createTeam(teamData) {
    const sid = localStorage.getItem('ad_session');
    const res = await fetch('/api/auth/teams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': sid },
      body: JSON.stringify(teamData),
    });
    return res.json();
  }

  /** 팀 삭제 (Master용) */
  async function deleteTeam(teamId) {
    const sid = localStorage.getItem('ad_session');
    const res = await fetch(`/api/auth/teams/${encodeURIComponent(teamId)}`, {
      method: 'DELETE',
      headers: { 'X-Session-Id': sid },
    });
    return res.json();
  }

  return {
    login, logout, checkSession, currentUser,
    getTeams, getUsers, createUser, deleteUser, updateUser,
    createTeam, deleteTeam,
  };
})();
