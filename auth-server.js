/* ============================================================
   auth-server.js — 서버 측 인증 모듈
   
   - 사용자/팀 관리 (JSON 파일 기반)
   - 세션 관리 (메모리 기반)
   - bcrypt 비밀번호 해싱
   - 팀별 DB 분리 (data/{teamId}/projects.json)
   ============================================================ */

const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const TEAMS_FILE = path.join(DATA_DIR, 'teams.json');
const SALT_ROUNDS = 10;

// 메모리 세션 저장소
const sessions = {};

// ── 헬퍼 함수 ──
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadJSON(fpath, fallback) {
  try {
    if (fs.existsSync(fpath)) return JSON.parse(fs.readFileSync(fpath, 'utf8'));
  } catch (e) { console.error(`[Auth] Failed to load ${fpath}:`, e.message); }
  return fallback;
}

function saveJSON(fpath, data) {
  ensureDir(path.dirname(fpath));
  fs.writeFileSync(fpath, JSON.stringify(data, null, 2), 'utf8');
}

// ── 사용자 DB ──
function loadUsers() { return loadJSON(USERS_FILE, []); }
function saveUsers(users) { saveJSON(USERS_FILE, users); }

function loadTeams() { return loadJSON(TEAMS_FILE, []); }
function saveTeams(teams) { saveJSON(TEAMS_FILE, teams); }

// ── 초기화: 기본 계정 생성 ──
function initDefaults() {
  ensureDir(DATA_DIR);
  
  // 기본 팀
  let teams = loadTeams();
  if (teams.length === 0) {
    teams = [
      { id: 'master', name: 'Master', description: '시스템 관리자', createdAt: new Date().toISOString() },
      { id: 'gongmu', name: '공무팀', description: '공무팀 전용', createdAt: new Date().toISOString() },
    ];
    saveTeams(teams);
    console.log('[Auth] Default teams created: master, 공무팀');
  }

  // 기본 사용자
  let users = loadUsers();
  if (users.length === 0) {
    const masterPwHash = bcrypt.hashSync('kleannara12#', SALT_ROUNDS);
    const gongmuPwHash = bcrypt.hashSync('kleannara12#', SALT_ROUNDS);
    users = [
      {
        id: 'hmlee2',
        name: '관리자',
        password: masterPwHash,
        role: 'master',
        teamId: 'master',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'Gongmu',
        name: '공무팀',
        password: gongmuPwHash,
        role: 'team',
        teamId: 'gongmu',
        createdAt: new Date().toISOString(),
      },
    ];
    saveUsers(users);
    console.log('[Auth] Default users created: hmlee2 (master), Gongmu (공무팀)');
  }

  // 기존 projects.json → 공무팀 DB로 마이그레이션
  const oldProjectsFile = path.join(DATA_DIR, 'projects.json');
  const gongmuProjectsFile = path.join(DATA_DIR, 'gongmu', 'projects.json');
  if (fs.existsSync(oldProjectsFile) && !fs.existsSync(gongmuProjectsFile)) {
    ensureDir(path.join(DATA_DIR, 'gongmu'));
    fs.copyFileSync(oldProjectsFile, gongmuProjectsFile);
    console.log('[Auth] Migrated existing projects.json → data/gongmu/projects.json');
  }
}

// ── 세션 관리 ──
function createSession(userId) {
  const sessionId = uuidv4();
  sessions[sessionId] = {
    userId,
    createdAt: Date.now(),
    // 현재 활성 팀 (Master는 팀 전환 가능)
    activeTeamId: null,
  };
  return sessionId;
}

function getSession(sessionId) {
  return sessions[sessionId] || null;
}

function destroySession(sessionId) {
  delete sessions[sessionId];
}

// ── 팀별 프로젝트 경로 ──
function getTeamProjectsFile(teamId) {
  return path.join(DATA_DIR, teamId, 'projects.json');
}

function loadTeamProjects(teamId) {
  const fpath = getTeamProjectsFile(teamId);
  return loadJSON(fpath, []);
}

function saveTeamProjects(teamId, projects) {
  const fpath = getTeamProjectsFile(teamId);
  ensureDir(path.dirname(fpath));
  saveJSON(fpath, projects);
}

// ── Express 라우터 설정 ──
function setupAuthRoutes(app) {
  initDefaults();

  // 세션 인증 미들웨어
  function requireAuth(req, res, next) {
    const sid = req.headers['x-session-id'];
    const session = getSession(sid);
    if (!session) return res.status(401).json({ error: '로그인이 필요합니다.' });
    const users = loadUsers();
    const user = users.find(u => u.id === session.userId);
    if (!user) return res.status(401).json({ error: '사용자를 찾을 수 없습니다.' });
    req.authUser = user;
    req.session = session;
    req.sessionId = sid;
    next();
  }

  function requireMaster(req, res, next) {
    if (req.authUser.role !== 'master') {
      return res.status(403).json({ error: '마스터 권한이 필요합니다.' });
    }
    next();
  }

  // ── 로그인 ──
  app.post('/api/auth/login', (req, res) => {
    const { userId, password } = req.body;
    if (!userId || !password) return res.status(400).json({ error: 'ID와 비밀번호를 입력하세요.' });

    const users = loadUsers();
    const user = users.find(u => u.id === userId);
    if (!user) return res.status(401).json({ error: '존재하지 않는 계정입니다.' });

    if (!bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: '비밀번호가 일치하지 않습니다.' });
    }

    const sessionId = createSession(user.id);
    // Master는 기본적으로 자기 팀, 일반 사용자는 자기 팀
    sessions[sessionId].activeTeamId = user.teamId;

    const teams = loadTeams();
    const team = teams.find(t => t.id === user.teamId);

    console.log(`[Auth] Login: ${user.id} (${user.role}/${team?.name || user.teamId})`);
    res.json({
      success: true,
      sessionId,
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
        teamId: user.teamId,
        teamName: team?.name || user.teamId,
      },
    });
  });

  // ── 로그아웃 ──
  app.post('/api/auth/logout', (req, res) => {
    const { sessionId } = req.body;
    if (sessionId) {
      destroySession(sessionId);
      console.log('[Auth] Logout session:', sessionId.substring(0, 8) + '...');
    }
    res.json({ success: true });
  });

  // ── 세션 확인 ──
  app.get('/api/auth/session', requireAuth, (req, res) => {
    const teams = loadTeams();
    const team = teams.find(t => t.id === req.authUser.teamId);
    const activeTeam = teams.find(t => t.id === req.session.activeTeamId);
    res.json({
      success: true,
      user: {
        id: req.authUser.id,
        name: req.authUser.name,
        role: req.authUser.role,
        teamId: req.authUser.teamId,
        teamName: team?.name || req.authUser.teamId,
        activeTeamId: req.session.activeTeamId,
        activeTeamName: activeTeam?.name || req.session.activeTeamId,
      },
    });
  });

  // ── 활성 팀 전환 (Master 전용) ──
  app.post('/api/auth/switch-team', requireAuth, (req, res) => {
    const { teamId } = req.body;
    // Master는 아무 팀이나, 일반 사용자는 자기 팀만
    if (req.authUser.role !== 'master' && teamId !== req.authUser.teamId) {
      return res.status(403).json({ error: '권한이 없습니다.' });
    }
    const teams = loadTeams();
    const team = teams.find(t => t.id === teamId);
    if (!team) return res.status(404).json({ error: '팀을 찾을 수 없습니다.' });
    
    sessions[req.sessionId].activeTeamId = teamId;
    console.log(`[Auth] Team switch: ${req.authUser.id} → ${team.name}`);
    res.json({ success: true, teamId, teamName: team.name });
  });

  // ── 팀 목록 ──
  app.get('/api/auth/teams', requireAuth, (req, res) => {
    const teams = loadTeams();
    // Master는 전체, 일반은 자기 팀만
    if (req.authUser.role === 'master') {
      res.json({ success: true, teams: teams.filter(t => t.id !== 'master') });
    } else {
      res.json({ success: true, teams: teams.filter(t => t.id === req.authUser.teamId) });
    }
  });

  // ── 팀 생성 (Master 전용) ──
  app.post('/api/auth/teams', requireAuth, requireMaster, (req, res) => {
    const { id, name, description } = req.body;
    if (!id || !name) return res.status(400).json({ error: 'ID와 이름을 입력하세요.' });

    const teams = loadTeams();
    if (teams.find(t => t.id === id)) return res.status(409).json({ error: '이미 존재하는 팀 ID입니다.' });

    teams.push({ id, name, description: description || '', createdAt: new Date().toISOString() });
    saveTeams(teams);

    // 팀 DB 디렉토리 생성
    ensureDir(path.join(DATA_DIR, id));
    saveJSON(path.join(DATA_DIR, id, 'projects.json'), []);

    console.log(`[Auth] Team created: ${id} (${name})`);
    res.json({ success: true });
  });

  // ── 팀 삭제 (Master 전용) ──
  app.delete('/api/auth/teams/:teamId', requireAuth, requireMaster, (req, res) => {
    const { teamId } = req.params;
    if (teamId === 'master' || teamId === 'gongmu') {
      return res.status(400).json({ error: '기본 팀은 삭제할 수 없습니다.' });
    }

    let teams = loadTeams();
    teams = teams.filter(t => t.id !== teamId);
    saveTeams(teams);

    // 해당 팀 소속 사용자의 팀을 해제하지는 않음 (경고만)
    console.log(`[Auth] Team deleted: ${teamId}`);
    res.json({ success: true });
  });

  // ── 사용자 목록 (Master 전용) ──
  app.get('/api/auth/users', requireAuth, requireMaster, (req, res) => {
    const users = loadUsers().map(u => ({
      id: u.id, name: u.name, role: u.role, teamId: u.teamId, createdAt: u.createdAt,
    }));
    const teams = loadTeams();
    users.forEach(u => {
      const t = teams.find(t => t.id === u.teamId);
      u.teamName = t?.name || u.teamId;
    });
    res.json({ success: true, users });
  });

  // ── 사용자 생성 (Master 전용) ──
  app.post('/api/auth/users', requireAuth, requireMaster, (req, res) => {
    const { id, name, password, teamId } = req.body;
    if (!id || !password || !teamId) return res.status(400).json({ error: '필수 항목을 입력하세요.' });

    const users = loadUsers();
    if (users.find(u => u.id === id)) return res.status(409).json({ error: '이미 존재하는 사용자 ID입니다.' });

    const teams = loadTeams();
    if (!teams.find(t => t.id === teamId)) return res.status(400).json({ error: '존재하지 않는 팀입니다.' });

    users.push({
      id,
      name: name || id,
      password: bcrypt.hashSync(password, SALT_ROUNDS),
      role: 'team',
      teamId,
      createdAt: new Date().toISOString(),
    });
    saveUsers(users);

    console.log(`[Auth] User created: ${id} → ${teamId}`);
    res.json({ success: true });
  });

  // ── 사용자 수정 (Master 전용) ──
  app.put('/api/auth/users/:userId', requireAuth, requireMaster, (req, res) => {
    const { userId } = req.params;
    const { name, password, teamId } = req.body;

    const users = loadUsers();
    const user = users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    if (user.role === 'master') return res.status(400).json({ error: 'Master 계정은 수정할 수 없습니다.' });

    if (name) user.name = name;
    if (password) user.password = bcrypt.hashSync(password, SALT_ROUNDS);
    if (teamId) {
      const teams = loadTeams();
      if (!teams.find(t => t.id === teamId)) return res.status(400).json({ error: '존재하지 않는 팀입니다.' });
      user.teamId = teamId;
    }
    saveUsers(users);
    console.log(`[Auth] User updated: ${userId}`);
    res.json({ success: true });
  });

  // ── 사용자 삭제 (Master 전용) ──
  app.delete('/api/auth/users/:userId', requireAuth, requireMaster, (req, res) => {
    const { userId } = req.params;
    const users = loadUsers();
    const user = users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    if (user.role === 'master') return res.status(400).json({ error: 'Master 계정은 삭제할 수 없습니다.' });

    const filtered = users.filter(u => u.id !== userId);
    saveUsers(filtered);
    console.log(`[Auth] User deleted: ${userId}`);
    res.json({ success: true });
  });

  // ── 팀별 프로젝트 API (기존 /api/projects 대체) ──
  app.get('/api/projects', requireAuth, (req, res) => {
    const teamId = req.session.activeTeamId || req.authUser.teamId;
    const projects = loadTeamProjects(teamId);
    console.log(`[DB] GET /api/projects (team: ${teamId}) → ${projects.length}개`);
    res.json({ success: true, projects });
  });

  app.post('/api/projects', requireAuth, (req, res) => {
    const { projects } = req.body;
    if (!Array.isArray(projects)) return res.status(400).json({ error: 'projects must be an array' });
    const teamId = req.session.activeTeamId || req.authUser.teamId;
    saveTeamProjects(teamId, projects);
    console.log(`[DB] POST /api/projects (team: ${teamId}) ← ${projects.length}개 저장`);
    res.json({ success: true, count: projects.length });
  });

  return { requireAuth, getSession };
}

module.exports = { setupAuthRoutes };
