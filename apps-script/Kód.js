const CONFIG = Object.freeze({
  spreadsheetId: '1iXtcEwUTNos5GnzI8G21iOPFJ5p4Mh07Syha6o2nDuQ',
  firestoreProjectId: 'putovani-svetice-2026',
  firestoreDatabase: '(default)',
  logSheet: 'Log',
  codesSheet: 'Codes',
  statsSheet: 'RouteStats',
  usersSheet: 'Users',
  authCodesSheet: 'AuthCodes',
  sessionsSheet: 'Sessions',
  otpLifetimeMs: 10 * 60 * 1000,
  otpResendMs: 60 * 1000,
  otpMaxAttempts: 5,
  sessionLifetimeMs: 90 * 24 * 60 * 60 * 1000,
  sessionTouchMs: 60 * 60 * 1000,
  pointCacheSeconds: 6 * 60 * 60,
  sessionCacheSeconds: 5 * 60,
  userAccessCacheSeconds: 5 * 60,
  sheetSyncMinutes: 5,
  reportTimezone: 'Europe/Prague',
  dailyReportHour: 1
});

const HEADERS = Object.freeze({
  Users: ['UserId', 'Email', 'Status', 'CreatedAt', 'VerifiedAt', 'LastLoginAt', 'Role'],
  AuthCodes: ['Email', 'CodeHash', 'ExpiresAt', 'Attempts', 'RequestedAt', 'UsedAt'],
  Sessions: ['TokenHash', 'UserId', 'Email', 'CreatedAt', 'ExpiresAt', 'RevokedAt', 'LastSeenAt'],
  RouteStats: [
    'Uživatel', 'Trasa', 'Délka trasy [km]', 'Návštěvy startu',
    'Návštěvy kontroly', 'Návštěvy cíle', 'Dokončeno [počet]',
    'Dokončená vzdálenost [km]', 'Rozpracováno [počet]',
    'Nejvyšší postup [body]', 'Bodů na trase', 'Poslední aktivita',
    'Poslední bod', 'Aktualizováno'
  ]
});

function doGet(e) {
  const params = (e && e.parameter) || {};
  const action = params.action || 'code';
  try {
    if (action === 'ping') {
      return json_({ status: 'OK', version: 'firestore-1.0' });
    }
    if (action === 'code') return getPointResponse_(params.code);
    return json_({ status: 'ERROR', error: 'METHOD_NOT_ALLOWED' });
  } catch (err) {
    logError_('doGet', err, { action: action });
    return json_({ status: 'ERROR', error: 'SERVER_ERROR' });
  }
}

function doPost(e) {
  let data;
  try {
    data = parseRequest_(e);
  } catch (_) {
    return json_({ status: 'ERROR', error: 'INVALID_REQUEST' });
  }
  try {
    switch (data.action) {
      case 'requestCode': return requestVerificationCode_(data.email);
      case 'verifyCode': return verifyCode_(data.email, data.verificationCode, data.requestId);
      case 'session': return sessionInfo_(data.sessionToken);
      case 'visit': return recordVisit_(data.sessionToken, data.code, data.requestId);
      case 'stats': return statsResponse_(data.sessionToken);
      case 'adminUsers': return adminUsersResponse_(data.sessionToken);
      case 'adminParticipantStats': return adminParticipantStatsResponse_(data.sessionToken);
      case 'adminUsageReport': return adminUsageReportResponse_(data.sessionToken);
      case 'adminLog': return adminLogResponse_(data.sessionToken, data.offset, data.limit);
      case 'logout': return logout_(data.sessionToken);
      default: return json_({ status: 'ERROR', error: 'UNKNOWN_ACTION' });
    }
  } catch (err) {
    logError_('doPost:' + (data.action || 'unknown'), err, sanitizeForLog_(data));
    return json_({ status: 'ERROR', error: 'SERVER_ERROR' });
  }
}

function requestVerificationCode_(rawEmail) {
  const email = normalizeEmail_(rawEmail);
  if (!isValidEmail_(email)) return json_({ status: 'ERROR', error: 'INVALID_EMAIL' });
  setupAuth_();
  if (MailApp.getRemainingDailyQuota() < 1) {
    return json_({ status: 'ERROR', error: 'EMAIL_QUOTA_EXCEEDED' });
  }

  const lock = LockService.getUserLock();
  lock.waitLock(10000);
  let code;
  try {
    const id = emailDocumentId_(email);
    const latest = firestoreGet_('authCodes/' + id);
    const requestedAt = latest && asDate_(latest.requestedAt);
    if (requestedAt && Date.now() - requestedAt.getTime() < CONFIG.otpResendMs) {
      return json_({ status: 'ERROR', error: 'TOO_MANY_REQUESTS', retryAfter: 60 });
    }
    code = generateOtp_();
    const now = new Date();
    firestoreSet_('authCodes/' + id, {
      email: email,
      codeHash: hash_('otp:' + email + ':' + code),
      expiresAt: new Date(now.getTime() + CONFIG.otpLifetimeMs),
      attempts: 0,
      requestedAt: now,
      usedAt: null
    });
  } finally {
    lock.releaseLock();
  }

  MailApp.sendEmail({
    to: email,
    subject: 'Ověřovací kód - Putování Světice',
    body: 'Váš ověřovací kód je: ' + code + '\n\nKód platí 10 minut. Pokud jste o něj nežádali, tento e-mail ignorujte.',
    htmlBody: '<p>Váš ověřovací kód pro <strong>Putování Světice</strong> je:</p>' +
      '<p style="font-size:28px;font-weight:bold;letter-spacing:6px">' + code + '</p>' +
      '<p>Kód platí 10 minut. Pokud jste o něj nežádali, tento e-mail ignorujte.</p>',
    name: 'Putování Světice'
  });
  return json_({ status: 'OK' });
}

function verifyCode_(rawEmail, rawCode, rawRequestId) {
  const email = normalizeEmail_(rawEmail);
  const code = String(rawCode || '').replace(/\s/g, '');
  const requestId = normalizeVerificationRequestId_(rawRequestId);
  if (!isValidEmail_(email) || !/^\d{6}$/.test(code)) {
    return json_({ status: 'ERROR', error: 'INVALID_CODE' });
  }
  if (rawRequestId && !requestId) return json_({ status: 'ERROR', error: 'INVALID_REQUEST' });
  setupAuth_();
  const lock = LockService.getUserLock();
  lock.waitLock(10000);
  try {
    const authId = emailDocumentId_(email);
    const authCode = firestoreGet_('authCodes/' + authId);
    if (!authCode) return json_({ status: 'ERROR', error: 'INVALID_CODE' });
    const submittedCodeHash = hash_('otp:' + email + ':' + code);
    if (authCode.usedAt) {
      const resumed = requestId ? resumeVerifiedSession_(email, submittedCodeHash, requestId, authCode) : null;
      return resumed || json_({ status: 'ERROR', error: 'INVALID_CODE' });
    }
    const expiresAt = asDate_(authCode.expiresAt);
    const attempts = Number(authCode.attempts) || 0;
    if (!expiresAt || expiresAt.getTime() < Date.now()) {
      return json_({ status: 'ERROR', error: 'CODE_EXPIRED' });
    }
    if (attempts >= CONFIG.otpMaxAttempts) {
      return json_({ status: 'ERROR', error: 'TOO_MANY_ATTEMPTS' });
    }
    if (!constantTimeEqual_(authCode.codeHash, submittedCodeHash)) {
      authCode.attempts = attempts + 1;
      firestoreSet_('authCodes/' + authId, authCode);
      return json_({ status: 'ERROR', error: 'INVALID_CODE' });
    }

    const now = new Date();
    const emailIndex = firestoreGet_('userEmails/' + authId);
    const existing = emailIndex && emailIndex.userId ? firestoreGet_('users/' + emailIndex.userId) : null;
    const userId = existing && existing.userId ? existing.userId : Utilities.getUuid();
    const user = {
      userId: userId,
      email: email,
      status: 'ACTIVE',
      createdAt: existing && existing.createdAt ? existing.createdAt : now,
      verifiedAt: existing && existing.verifiedAt ? existing.verifiedAt : now,
      lastLoginAt: now,
      role: existing ? normalizeRole_(existing.role) : ''
    };
    const token = requestId ? verificationSessionToken_(email, requestId) : generateToken_();
    const tokenHash = hash_('session:' + token);
    const expires = new Date(now.getTime() + CONFIG.sessionLifetimeMs);
    authCode.usedAt = now;
    authCode.verificationRequestIdHash = requestId ? verificationRequestIdHash_(email, requestId) : '';

    const sessionDocument = {
      tokenHash: tokenHash,
      userId: userId,
      email: email,
      createdAt: now,
      expiresAt: expires,
      revokedAt: null,
      lastSeenAt: now
    };
    firestoreCommit_([
      firestoreWriteSet_('authCodes/' + authId, authCode),
      firestoreWriteSet_('users/' + userId, user),
      firestoreWriteSet_('userEmails/' + authId, { email: email, userId: userId }),
      firestoreWriteSet_('sessions/' + tokenHash, sessionDocument)
    ]);
    cachePutJson_('session:v1:' + tokenHash, sessionDocument, CONFIG.sessionCacheSeconds);
    cachePutJson_('access:v1:' + userId, {
      email: email, role: user.role, status: user.status
    }, CONFIG.userAccessCacheSeconds);
    return json_(verificationResponse_(token, email, expires, {
      role: user.role, isAdmin: user.role === 'admin'
    }));
  } finally {
    lock.releaseLock();
  }
}

function normalizeVerificationRequestId_(value) {
  const requestId = String(value || '').trim();
  return /^verify_[A-Za-z0-9_-]{16,100}$/.test(requestId) ? requestId : '';
}

function verificationRequestIdHash_(email, requestId) {
  return hash_('verification-request:' + email + ':' + requestId);
}

function verificationSessionToken_(email, requestId) {
  return hash_('verification-session:' + email + ':' + requestId);
}

function resumeVerifiedSession_(email, submittedCodeHash, requestId, authCode) {
  const storedRequestHash = String(authCode.verificationRequestIdHash || '');
  if (!storedRequestHash ||
      !constantTimeEqual_(storedRequestHash, verificationRequestIdHash_(email, requestId)) ||
      !constantTimeEqual_(String(authCode.codeHash || ''), submittedCodeHash)) {
    return null;
  }
  const token = verificationSessionToken_(email, requestId);
  const tokenHash = hash_('session:' + token);
  const session = firestoreGet_('sessions/' + tokenHash);
  const expiresAt = session && asDate_(session.expiresAt);
  if (!session || session.revokedAt || normalizeEmail_(session.email) !== email ||
      !expiresAt || expiresAt.getTime() < Date.now()) {
    return null;
  }
  cachePutJson_('session:v1:' + tokenHash, session, CONFIG.sessionCacheSeconds);
  const access = getUserAccess_({ userId: String(session.userId), email: email });
  return json_(verificationResponse_(token, email, expiresAt, access));
}

function verificationResponse_(token, email, expiresAt, access) {
  return {
    status: 'OK', sessionToken: token, email: email,
    expiresAt: expiresAt.toISOString(), role: access.role, isAdmin: Boolean(access.isAdmin)
  };
}

function sessionInfo_(token) {
  const session = requireSession_(token);
  if (!session) return json_({ status: 'ERROR', error: 'UNAUTHORIZED' });
  const access = getUserAccess_(session);
  return json_({
    status: 'OK', email: session.email, expiresAt: session.expiresAt.toISOString(),
    role: access.role, isAdmin: access.isAdmin
  });
}

function recordVisit_(token, rawCode, rawRequestId) {
  const session = requireSession_(token);
  if (!session) return json_({ status: 'ERROR', error: 'UNAUTHORIZED' });
  const point = findPoint_(rawCode);
  if (!point) return json_({ status: 'ERROR', error: 'INVALID_POINT' });
  const requestId = normalizeVisitRequestId_(rawRequestId);
  if (rawRequestId && !requestId) return json_({ status: 'ERROR', error: 'INVALID_REQUEST' });

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const visitId = requestId || Utilities.getUuid();
    const now = new Date();
    const summaryPath = 'routeStats/' + routeStatsDocumentId_(session.userId, point.routeKey);
    const currentDocuments = firestoreGetMany_([summaryPath, 'aggregates/stats']);
    const previous = currentDocuments[0] || emptyRouteStats_(session, point);
    const completedBefore = Number(previous.completedCount) || 0;
    const summary = applyVisitToStats_(previous, point, now);
    const completedDelta = summary.completedCount - completedBefore;
    const aggregate = currentDocuments[1] || { totalDistanceKm: 0, visitCount: 0 };
    aggregate.totalDistanceKm = (Number(aggregate.totalDistanceKm) || 0) + completedDelta * point.distanceKm;
    aggregate.visitCount = (Number(aggregate.visitCount) || 0) + 1;
    aggregate.updatedAt = now;
    const response = visitResponse_(point, completedDelta > 0, Number(summary.incompleteCount) > 0);
    try {
      firestoreCommit_([
        requestId ? firestoreWriteCreate_('visits/' + visitId, {
          visitId: visitId, visitedAt: now, code: point.code, description: point.text,
          userId: session.userId, email: session.email, route: point.route,
          routeKey: point.routeKey, color: point.route,
          routeCompleted: response.routeCompleted, routeIncomplete: response.routeIncomplete
        }) : firestoreWriteSet_('visits/' + visitId, {
          visitId: visitId, visitedAt: now, code: point.code, description: point.text,
          userId: session.userId, email: session.email, route: point.route,
          routeKey: point.routeKey, color: point.route,
          routeCompleted: response.routeCompleted, routeIncomplete: response.routeIncomplete
        }),
        firestoreWriteSet_(summaryPath, summary),
        firestoreWriteSet_('aggregates/stats', aggregate)
      ]);
    } catch (error) {
      if (!requestId || !/Firestore HTTP 409|ALREADY_EXISTS/i.test(String(error && error.message))) throw error;
      const existingVisit = firestoreGet_('visits/' + visitId);
      if (!existingVisit || String(existingVisit.userId) !== session.userId || String(existingVisit.code) !== point.code) {
        return json_({ status: 'ERROR', error: 'INVALID_REQUEST' });
      }
      return json_(visitResponse_(point, Boolean(existingVisit.routeCompleted), Boolean(existingVisit.routeIncomplete)));
    }
    response.email = session.email;
    return json_(response);
  } finally {
    lock.releaseLock();
  }
}

function normalizeVisitRequestId_(value) {
  const requestId = String(value || '').trim();
  return /^[A-Za-z0-9_-]{16,100}$/.test(requestId) ? requestId : '';
}

function visitResponse_(point, routeCompleted, routeIncomplete) {
  return {
    status: 'OK', mapUrl: point.mapUrl, route: point.route, lastPoint: point.text,
    routeCompleted: Boolean(routeCompleted), routeIncomplete: Boolean(routeIncomplete)
  };
}

function emptyRouteStats_(session, point) {
  return {
    userId: session.userId,
    email: session.email,
    route: point.route,
    routeKey: point.routeKey,
    distanceKm: point.distanceKm,
    visits: new Array(point.totalPoints).fill(0),
    completedCount: 0,
    openAttempts: [],
    incompleteCount: 0,
    progressPoints: 0,
    totalPoints: point.totalPoints,
    lastActivity: null,
    lastPoint: '',
    updatedAt: null
  };
}

function applyVisitToStats_(summary, point, now) {
  const visits = Array.isArray(summary.visits) ? summary.visits.slice() : [];
  while (visits.length < point.totalPoints) visits.push(0);
  visits[point.pointIndex] = (Number(visits[point.pointIndex]) || 0) + 1;
  let openAttempts = (Array.isArray(summary.openAttempts) ? summary.openAttempts : [])
    .map(function(value) { return Number(value) || 0; });
  let completedCount = Number(summary.completedCount) || 0;
  const attemptResult = advanceRouteAttempt_(openAttempts, point.pointIndex, point.totalPoints);
  openAttempts = attemptResult.openAttempts;
  if (attemptResult.completed) completedCount++;
  summary.visits = visits;
  summary.completedCount = completedCount;
  summary.openAttempts = openAttempts;
  summary.incompleteCount = openAttempts.length;
  summary.progressPoints = openAttempts.reduce(function(maximum, attempt) {
    return Math.max(maximum, routeAttemptProgress_(attempt, point.totalPoints));
  }, 0);
  summary.lastActivity = now;
  summary.lastPoint = point.text;
  summary.updatedAt = now;
  return summary;
}

// Positive attempts proceed START -> QR -> CÍL and contain the next point index.
// Negative attempts proceed CÍL -> QR -> START and encode that next index as
// -(index + 1), so both directions fit the existing numeric Firestore field.
function advanceRouteAttempt_(openAttempts, pointIndex, totalPoints) {
  const attempts = openAttempts.slice();
  for (let i = 0; i < attempts.length; i++) {
    if (attempts[i] === pointIndex) {
      const nextIndex = pointIndex + 1;
      if (nextIndex === totalPoints) return { openAttempts: [], completed: true };
      attempts[i] = nextIndex;
      return { openAttempts: attempts, completed: false };
    }
    if (attempts[i] === -(pointIndex + 1)) {
      if (pointIndex === 0) return { openAttempts: [], completed: true };
      attempts[i] = -pointIndex;
      return { openAttempts: attempts, completed: false };
    }
  }

  if (pointIndex === 0) {
    return totalPoints === 1
      ? { openAttempts: attempts, completed: true }
      : { openAttempts: attempts.concat([1]), completed: false };
  }
  if (pointIndex === totalPoints - 1) {
    return { openAttempts: attempts.concat([-pointIndex]), completed: false };
  }
  return { openAttempts: attempts, completed: false };
}

function routeAttemptProgress_(attempt, totalPoints) {
  return attempt >= 0 ? attempt : totalPoints + attempt;
}

function statsResponse_(token) {
  const session = requireSession_(token);
  if (!session) return json_({ status: 'ERROR', error: 'UNAUTHORIZED' });
  const result = firestoreQueryAndGet_('routeStats', {
    fieldFilter: { field: { fieldPath: 'userId' }, op: 'EQUAL', value: firestoreValue_(session.userId) }
  }, {}, 'aggregates/stats');
  const summaries = result.documents;
  const aggregate = result.document || {};
  let totalPersonalDistanceKm = 0;
  let activeRoute = '';
  let activeRouteLastPoint = '';
  let activeRouteTime = -1;
  const stats = summaries.map(function(item) {
    const completedCount = Number(item.completedCount) || 0;
    const completedDistanceKm = completedCount * (Number(item.distanceKm) || 0);
    totalPersonalDistanceKm += completedDistanceKm;
    const incompleteCount = Number(item.incompleteCount) || 0;
    const activity = asDate_(item.lastActivity);
    const activityTime = activity ? activity.getTime() : 0;
    if (incompleteCount > 0 && activityTime >= activeRouteTime) {
      activeRoute = String(item.route || '');
      activeRouteLastPoint = String(item.lastPoint || '');
      activeRouteTime = activityTime;
    }
    return {
      route: item.route || '', distanceKm: Number(item.distanceKm) || 0,
      completedCount: completedCount, completedDistanceKm: completedDistanceKm,
      incompleteCount: incompleteCount, progressPoints: Number(item.progressPoints) || 0,
      totalPoints: Number(item.totalPoints) || 0,
      lastActivity: formatDateTime_(item.lastActivity), lastPoint: item.lastPoint || '',
      success: completedCount > 0
    };
  });
  stats.sort(function(a, b) { return a.route.localeCompare(b.route, 'cs'); });
  return json_({
    status: 'OK', email: session.email, stats: stats,
    totalPersonalDistanceKm: totalPersonalDistanceKm,
    activeRoute: activeRoute, activeRouteLastPoint: activeRouteLastPoint,
    totalDistanceKm: Number(aggregate.totalDistanceKm) || 0
  });
}

function adminUsersResponse_(token) {
  const authorization = authorizeAdmin_(token);
  if (authorization.error) return json_({ status: 'ERROR', error: authorization.error });
  const users = firestoreList_('users').map(function(user) {
    return {
      email: user.email || '', status: user.status || '', role: user.role || '',
      createdAt: formatDateTime_(user.createdAt), verifiedAt: formatDateTime_(user.verifiedAt),
      lastLoginAt: formatDateTime_(user.lastLoginAt)
    };
  }).filter(function(user) { return user.email; });
  users.sort(function(a, b) { return a.email.localeCompare(b.email); });
  return json_({ status: 'OK', users: users, total: users.length });
}

function adminParticipantStatsResponse_(token) {
  const authorization = authorizeAdmin_(token);
  if (authorization.error) return json_({ status: 'ERROR', error: authorization.error });
  const participants = buildAdminParticipantStats_(
    firestoreList_('users'),
    firestoreList_('routeStats')
  );
  return json_({ status: 'OK', participants: participants, total: participants.length });
}

function buildAdminParticipantStats_(users, summaries) {
  const distanceByUserId = {};
  (summaries || []).forEach(function(summary) {
    const userId = String(summary.userId || '');
    if (!userId) return;
    const completedDistanceKm = (Number(summary.completedCount) || 0) *
      (Number(summary.distanceKm) || 0);
    distanceByUserId[userId] = (distanceByUserId[userId] || 0) + completedDistanceKm;
  });
  const participants = (users || []).map(function(user) {
    const userId = String(user.userId || user.__id || '');
    return {
      email: normalizeEmail_(user.email),
      totalDistanceKm: distanceByUserId[userId] || 0
    };
  }).filter(function(participant) { return participant.email; });
  participants.sort(function(a, b) {
    return b.totalDistanceKm - a.totalDistanceKm || a.email.localeCompare(b.email);
  });
  return participants;
}

function adminUsageReportResponse_(token) {
  const authorization = authorizeAdmin_(token);
  if (authorization.error) return json_({ status: 'ERROR', error: authorization.error });
  let report = firestoreGet_('adminReports/dailyUsage');
  if (!report) report = generateDailyAdminReport_();
  return json_({ status: 'OK', report: report });
}

function generateDailyAdminReport() {
  const report = refreshDailyAdminReportIfNeeded_();
  if (!report) return 'Denní report se před plánovanou hodinou neaktualizuje.';
  return 'Denní report je aktuální: ' + report.reportDate + ', ' + report.summary.totalVisits + ' návštěv.';
}

function generateDailyAdminReport_() {
  const generatedAt = new Date();
  const report = buildAdminUsageReport_(
    firestoreList_('visits'),
    firestoreList_('routeStats'),
    generatedAt,
    firestoreList_('points')
  );
  firestoreSet_('adminReports/dailyUsage', report);
  return report;
}

function refreshDailyAdminReportIfNeeded_() {
  const now = new Date();
  const local = reportLocalParts_(now);
  if (local.hour < CONFIG.dailyReportHour) return null;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return firestoreGet_('adminReports/dailyUsage');
  try {
    const current = firestoreGet_('adminReports/dailyUsage');
    if (current && current.reportDate === local.dateKey) return current;
    return generateDailyAdminReport_();
  } finally {
    lock.releaseLock();
  }
}

function buildAdminUsageReport_(visits, summaries, generatedAt, pointDefinitions) {
  const now = asDate_(generatedAt) || new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const last7Start = now.getTime() - 7 * dayMs;
  const previous7Start = now.getTime() - 14 * dayMs;
  const last30Start = now.getTime() - 30 * dayMs;
  const routes = {};
  const points = {};
  const participants = {};
  const active30 = {};
  const hours = [];
  const weekdays = [];
  const days = {};
  const weekdayNames = ['Neděle', 'Pondělí', 'Úterý', 'Středa', 'Čtvrtek', 'Pátek', 'Sobota'];
  let visitsLast7 = 0;
  let visitsPrevious7 = 0;
  let firstVisit = null;
  let lastVisit = null;
  for (let hour = 0; hour < 24; hour++) hours.push({ hour: hour, label: String(hour).padStart(2, '0') + ':00–' + String((hour + 1) % 24).padStart(2, '0') + ':00', visits: 0 });
  for (let weekday = 0; weekday < 7; weekday++) weekdays.push({ weekday: weekday, label: weekdayNames[weekday], visits: 0 });

  (pointDefinitions || []).forEach(function(point) {
    const routeName = String(point.route || 'Neznámá trasa');
    const routeKey = String(point.routeKey || routeKey_(routeName) || routeName);
    if (!routes[routeKey]) routes[routeKey] = {
      route: routeName, routeKey: routeKey, visits: 0, visitsLast30: 0,
      participantIds: {}, completedCount: 0, completedDistanceKm: 0, openAttempts: 0
    };
    const pointKey = String(point.code || point.__id || point.text || 'unknown');
    if (!points[pointKey]) points[pointKey] = {
      code: String(point.code || point.__id || ''), point: String(point.text || 'Neznámý bod'),
      route: routeName, visits: 0, participantIds: {}, lastVisitAt: null
    };
  });

  (visits || []).forEach(function(visit) {
    const visitedAt = asDate_(visit.visitedAt);
    if (!visitedAt) return;
    const timestamp = visitedAt.getTime();
    const userId = String(visit.userId || visit.email || '');
    const routeName = String(visit.route || visit.color || 'Neznámá trasa');
    const routeKey = String(visit.routeKey || routeKey_(routeName) || routeName);
    const local = reportLocalParts_(visitedAt);
    if (!firstVisit || timestamp < firstVisit.getTime()) firstVisit = visitedAt;
    if (!lastVisit || timestamp > lastVisit.getTime()) lastVisit = visitedAt;
    if (userId) participants[userId] = true;
    if (timestamp >= last30Start && userId) active30[userId] = true;
    if (timestamp >= last7Start) visitsLast7++;
    else if (timestamp >= previous7Start) visitsPrevious7++;
    hours[local.hour].visits++;
    weekdays[local.weekday].visits++;
    days[local.dateKey] = (days[local.dateKey] || 0) + 1;

    if (!routes[routeKey]) routes[routeKey] = {
      route: routeName, routeKey: routeKey, visits: 0, visitsLast30: 0,
      participantIds: {}, completedCount: 0, completedDistanceKm: 0, openAttempts: 0
    };
    routes[routeKey].visits++;
    if (timestamp >= last30Start) routes[routeKey].visitsLast30++;
    if (userId) routes[routeKey].participantIds[userId] = true;

    const pointKey = String(visit.code || visit.description || 'unknown');
    if (!points[pointKey]) points[pointKey] = {
      code: String(visit.code || ''), point: String(visit.description || 'Neznámý bod'),
      route: routeName, visits: 0, participantIds: {}, lastVisitAt: null
    };
    points[pointKey].visits++;
    if (userId) points[pointKey].participantIds[userId] = true;
    if (!points[pointKey].lastVisitAt || timestamp > points[pointKey].lastVisitAt.getTime()) {
      points[pointKey].lastVisitAt = visitedAt;
    }
  });

  let completedRoutes = 0;
  let completedDistanceKm = 0;
  let openAttempts = 0;
  (summaries || []).forEach(function(summary) {
    const routeName = String(summary.route || 'Neznámá trasa');
    const routeKey = String(summary.routeKey || routeKey_(routeName) || routeName);
    if (!routes[routeKey]) routes[routeKey] = {
      route: routeName, routeKey: routeKey, visits: 0, visitsLast30: 0,
      participantIds: {}, completedCount: 0, completedDistanceKm: 0, openAttempts: 0
    };
    const completed = Number(summary.completedCount) || 0;
    const incomplete = Number(summary.incompleteCount) || 0;
    const distance = completed * (Number(summary.distanceKm) || 0);
    routes[routeKey].completedCount += completed;
    routes[routeKey].completedDistanceKm += distance;
    routes[routeKey].openAttempts += incomplete;
    completedRoutes += completed;
    completedDistanceKm += distance;
    openAttempts += incomplete;
  });

  const routeRows = Object.keys(routes).map(function(key) {
    const route = routes[key];
    return {
      route: route.route, routeKey: route.routeKey, visits: route.visits,
      visitsLast30: route.visitsLast30,
      uniqueParticipants: Object.keys(route.participantIds).length,
      completedCount: route.completedCount,
      completedDistanceKm: roundReportNumber_(route.completedDistanceKm),
      openAttempts: route.openAttempts
    };
  }).sort(function(a, b) { return b.visits - a.visits || b.completedCount - a.completedCount || a.route.localeCompare(b.route, 'cs'); });

  const pointRows = Object.keys(points).map(function(key) {
    const point = points[key];
    return {
      code: point.code, point: point.point, route: point.route, visits: point.visits,
      uniqueParticipants: Object.keys(point.participantIds).length,
      lastVisitAt: point.lastVisitAt ? point.lastVisitAt.toISOString() : ''
    };
  }).sort(function(a, b) { return b.visits - a.visits || a.point.localeCompare(b.point, 'cs'); });

  const busiestDayEntry = Object.keys(days).map(function(date) { return { date: date, visits: days[date] }; })
    .sort(function(a, b) { return b.visits - a.visits || b.date.localeCompare(a.date); })[0] || null;
  const busiestHourCandidate = hours.slice().sort(function(a, b) { return b.visits - a.visits || a.hour - b.hour; })[0];
  const busiestWeekdayCandidate = weekdays.slice().sort(function(a, b) { return b.visits - a.visits || a.weekday - b.weekday; })[0];
  const busiestHour = busiestHourCandidate && busiestHourCandidate.visits ? busiestHourCandidate : null;
  const busiestWeekday = busiestWeekdayCandidate && busiestWeekdayCandidate.visits ? busiestWeekdayCandidate : null;
  const totalAttempts = completedRoutes + openAttempts;
  const changePercent = visitsPrevious7 > 0 ? ((visitsLast7 - visitsPrevious7) / visitsPrevious7) * 100 : null;
  return {
    version: 1,
    reportDate: reportLocalParts_(now).dateKey,
    generatedAt: now,
    timezone: CONFIG.reportTimezone,
    periodStart: firstVisit ? firstVisit.toISOString() : '',
    periodEnd: lastVisit ? lastVisit.toISOString() : '',
    summary: {
      totalVisits: (visits || []).filter(function(visit) { return Boolean(asDate_(visit.visitedAt)); }).length,
      uniqueParticipants: Object.keys(participants).length,
      activeParticipantsLast30: Object.keys(active30).length,
      completedRoutes: completedRoutes,
      completedDistanceKm: roundReportNumber_(completedDistanceKm),
      openAttempts: openAttempts,
      completionRatePercent: totalAttempts ? roundReportNumber_(completedRoutes / totalAttempts * 100) : 0,
      visitsLast7: visitsLast7,
      visitsPrevious7: visitsPrevious7,
      sevenDayChangePercent: changePercent === null ? null : roundReportNumber_(changePercent),
      busiestDay: busiestDayEntry,
      busiestHour: busiestHour,
      busiestWeekday: busiestWeekday
    },
    routes: routeRows,
    points: pointRows,
    hours: hours,
    weekdays: [weekdays[1], weekdays[2], weekdays[3], weekdays[4], weekdays[5], weekdays[6], weekdays[0]]
  };
}

function reportLocalParts_(date) {
  const formatted = Utilities.formatDate(asDate_(date), CONFIG.reportTimezone, 'yyyy-MM-dd|H');
  const parts = formatted.split('|');
  const dateKey = parts[0];
  return {
    dateKey: dateKey,
    hour: Number(parts[1]) || 0,
    weekday: new Date(dateKey + 'T12:00:00Z').getUTCDay()
  };
}

function roundReportNumber_(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

function adminLogResponse_(token, rawOffset, rawLimit) {
  const authorization = authorizeAdmin_(token);
  if (authorization.error) return json_({ status: 'ERROR', error: authorization.error });
  const offset = Math.max(0, Math.floor(Number(rawOffset) || 0));
  const limit = Math.min(200, Math.max(1, Math.floor(Number(rawLimit) || 100)));
  const result = firestoreQueryAndGet_('visits', null, {
    orderBy: [{ field: { fieldPath: 'visitedAt' }, direction: 'DESCENDING' }],
    offset: offset,
    limit: limit
  }, 'aggregates/stats');
  const visits = result.documents;
  const aggregate = result.document || {};
  const total = Number(aggregate.visitCount) || 0;
  const entries = visits.map(function(visit) {
    return {
      date: formatDateTime_(visit.visitedAt), code: visit.code || '',
      description: visit.description || '', user: visit.email || '',
      color: visit.color || visit.route || ''
    };
  });
  return json_({
    status: 'OK', entries: entries, total: total, offset: offset,
    nextOffset: offset + entries.length, hasMore: offset + entries.length < total
  });
}

function logout_(token) {
  const normalizedToken = String(token || '');
  if (!normalizedToken) return json_({ status: 'OK' });
  setupAuth_();
  const tokenHash = hash_('session:' + normalizedToken);
  const path = 'sessions/' + tokenHash;
  const session = firestoreGet_(path);
  if (session && !session.revokedAt) {
    session.revokedAt = new Date();
    firestoreSet_(path, session);
  }
  CacheService.getScriptCache().remove('session:v1:' + tokenHash);
  return json_({ status: 'OK' });
}

function getPointResponse_(code) {
  const point = findPoint_(code);
  if (!point) return json_({ status: 'ERROR', error: code ? 'POINT_NOT_FOUND' : 'MISSING_CODE' });
  return json_({ status: 'OK', text: point.text, mapUrl: point.mapUrl, route: point.route });
}

function findPoint_(rawCode) {
  const code = String(rawCode || '').trim();
  if (!code) return null;
  const cacheKey = 'point:v1:' + code;
  let point = cacheGetJson_(cacheKey);
  if (!point) {
    point = firestoreGet_('points/' + encodeURIComponent(code));
    if (point) cachePutJson_(cacheKey, point, CONFIG.pointCacheSeconds);
  }
  if (!point) return null;
  return {
    code: code, route: point.route || '', routeKey: point.routeKey || routeKey_(point.route),
    text: point.text || '', mapUrl: point.mapUrl || '',
    distanceKm: Number(point.distanceKm) || 0,
    pointIndex: Number(point.pointIndex) || 0,
    totalPoints: Number(point.totalPoints) || 0
  };
}

function requireSession_(rawToken) {
  const token = String(rawToken || '');
  if (token.length < 40 || token.length > 200) return null;
  setupAuth_();
  const tokenHash = hash_('session:' + token);
  const path = 'sessions/' + tokenHash;
  const cacheKey = 'session:v1:' + tokenHash;
  let session = cacheGetJson_(cacheKey);
  if (!session) session = firestoreGet_(path);
  if (!session || session.revokedAt) return null;
  const expiresAt = asDate_(session.expiresAt);
  if (!expiresAt || expiresAt.getTime() < Date.now()) return null;
  const email = normalizeEmail_(session.email);
  if (!isValidEmail_(email)) return null;
  const lastSeenAt = asDate_(session.lastSeenAt);
  if (!lastSeenAt || Date.now() - lastSeenAt.getTime() > CONFIG.sessionTouchMs) {
    session.lastSeenAt = new Date();
    firestoreSet_(path, session);
  }
  cachePutJson_(cacheKey, session, CONFIG.sessionCacheSeconds);
  return { userId: String(session.userId), email: email, expiresAt: expiresAt };
}

function authorizeAdmin_(token) {
  const session = requireSession_(token);
  if (!session) return { error: 'UNAUTHORIZED' };
  const access = getUserAccess_(session);
  if (!access.isAdmin) return { error: 'FORBIDDEN' };
  return { session: session, access: access };
}

function getUserAccess_(session) {
  const cacheKey = 'access:v1:' + session.userId;
  let user = cacheGetJson_(cacheKey);
  if (!user) {
    user = firestoreGet_('users/' + session.userId);
    if (user) cachePutJson_(cacheKey, user, CONFIG.userAccessCacheSeconds);
  }
  if (!user || normalizeEmail_(user.email) !== session.email) return { role: '', isAdmin: false };
  const role = normalizeRole_(user.role);
  const active = String(user.status || '').trim().toUpperCase() === 'ACTIVE';
  return { role: role, isAdmin: active && role === 'admin' };
}

function setupAuth() {
  setupAuth_();
  return 'OK';
}

function authorizeApplication() {
  setupAuth_();
  firestoreGet_('aggregates/stats');
  return 'Aplikace je autorizována pro Firestore, Sheets a MailApp. Zbývající denní kvóta e-mailů: ' +
    MailApp.getRemainingDailyQuota();
}

function configureFirestoreProject(projectId) {
  const normalized = String(projectId || '').trim();
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(normalized)) throw new Error('Neplatné Google Cloud project ID');
  PropertiesService.getScriptProperties().setProperty('FIRESTORE_PROJECT_ID', normalized);
  return 'Firestore project nastaven: ' + normalized;
}

function installSheetSyncTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'syncFirestoreToSheets') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('syncFirestoreToSheets').timeBased().everyMinutes(CONFIG.sheetSyncMinutes).create();
  return 'Asynchronní synchronizace Firestore -> Google Sheets běží každých ' + CONFIG.sheetSyncMinutes + ' minut.';
}

function installDailyAdminReportTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'generateDailyAdminReport') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('generateDailyAdminReport')
    .timeBased()
    .atHour(CONFIG.dailyReportHour)
    .everyDays(1)
    .inTimezone(CONFIG.reportTimezone)
    .create();
  return 'Denní administrátorský report je naplánován po ' + CONFIG.dailyReportHour + '. hodině (' + CONFIG.reportTimezone + ').';
}

function setupAuth_() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('AUTH_PEPPER')) {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      if (!props.getProperty('AUTH_PEPPER')) props.setProperty('AUTH_PEPPER', generateToken_());
    } finally {
      lock.releaseLock();
    }
  }
}

function migrateSheetsToFirestore() {
  setupAuth_();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = spreadsheet_();
    const codeValues = ss.getSheetByName(CONFIG.codesSheet).getDataRange().getDisplayValues();
    const definitions = buildRouteDefinitions_(codeValues);
    const pointWrites = [];
    definitions.routes.forEach(function(route) {
      route.points.forEach(function(point) {
        pointWrites.push(firestoreWriteSet_('points/' + encodeURIComponent(point.code), {
          code: point.code, route: route.name, routeKey: routeKey_(route.name),
          text: point.text, mapUrl: point.mapUrl, distanceKm: route.distanceKm,
          pointIndex: point.index, totalPoints: route.points.length
        }));
      });
    });
    firestoreCommitChunks_(pointWrites);

    const userValues = sheetValues_(ss, CONFIG.usersSheet);
    const usersByEmail = {};
    const userWrites = [];
    for (let i = 1; i < userValues.length; i++) {
      const email = normalizeEmail_(userValues[i][1]);
      if (!email) continue;
      const userId = String(userValues[i][0] || Utilities.getUuid());
      const user = {
        userId: userId, email: email, status: String(userValues[i][2] || 'ACTIVE'),
        createdAt: asDate_(userValues[i][3]), verifiedAt: asDate_(userValues[i][4]),
        lastLoginAt: asDate_(userValues[i][5]), role: normalizeRole_(userValues[i][6])
      };
      usersByEmail[email] = user;
      userWrites.push(firestoreWriteSet_('users/' + userId, user));
      userWrites.push(firestoreWriteSet_('userEmails/' + emailDocumentId_(email), { email: email, userId: userId }));
    }
    firestoreCommitChunks_(userWrites);

    const authValues = sheetValues_(ss, CONFIG.authCodesSheet);
    const latestAuth = {};
    for (let i = 1; i < authValues.length; i++) {
      const email = normalizeEmail_(authValues[i][0]);
      if (email) latestAuth[email] = authValues[i];
    }
    firestoreCommitChunks_(Object.keys(latestAuth).map(function(email) {
      const row = latestAuth[email];
      return firestoreWriteSet_('authCodes/' + emailDocumentId_(email), {
        email: email, codeHash: String(row[1] || ''), expiresAt: asDate_(row[2]),
        attempts: Number(row[3]) || 0, requestedAt: asDate_(row[4]), usedAt: asDate_(row[5])
      });
    }));

    const sessionValues = sheetValues_(ss, CONFIG.sessionsSheet);
    const sessionWrites = [];
    for (let i = 1; i < sessionValues.length; i++) {
      const tokenHash = String(sessionValues[i][0] || '');
      if (!tokenHash) continue;
      sessionWrites.push(firestoreWriteSet_('sessions/' + tokenHash, {
        tokenHash: tokenHash, userId: String(sessionValues[i][1] || ''),
        email: normalizeEmail_(sessionValues[i][2]), createdAt: asDate_(sessionValues[i][3]),
        expiresAt: asDate_(sessionValues[i][4]), revokedAt: asDate_(sessionValues[i][5]),
        lastSeenAt: asDate_(sessionValues[i][6])
      }));
    }
    firestoreCommitChunks_(sessionWrites);

    const logSheet = ss.getSheetByName(CONFIG.logSheet);
    const logValues = logSheet && logSheet.getLastRow() > 1 ?
      logSheet.getRange(2, 1, logSheet.getLastRow() - 1, 5).getValues() : [];
    const events = [];
    const visitWrites = [];
    for (let i = 0; i < logValues.length; i++) {
      const code = String(logValues[i][1] || '').trim();
      const point = definitions.byCode[code];
      const email = normalizeEmail_(logValues[i][3]);
      const date = asDate_(logValues[i][0]);
      if (!code || !email || !date) continue;
      let user = usersByEmail[email];
      if (!user) {
        user = { userId: Utilities.getUuid(), email: email, status: 'ACTIVE', createdAt: date, verifiedAt: date, lastLoginAt: date, role: '' };
        usersByEmail[email] = user;
        firestoreCommitChunks_([
          firestoreWriteSet_('users/' + user.userId, user),
          firestoreWriteSet_('userEmails/' + emailDocumentId_(email), { email: email, userId: user.userId })
        ]);
      }
      visitWrites.push(firestoreWriteSet_('visits/legacy-' + String(i + 2), {
        visitId: 'legacy-' + String(i + 2), visitedAt: date, code: code,
        description: String(logValues[i][2] || (point && point.text) || ''),
        userId: user.userId, email: email,
        route: point ? point.route.name : String(logValues[i][4] || ''),
        routeKey: point ? routeKey_(point.route.name) : routeKey_(logValues[i][4]),
        color: String(logValues[i][4] || (point && point.route.name) || '')
      }));
      if (point) events.push({ user: email, point: point, date: date, time: date.getTime(), row: i + 2 });
    }
    firestoreCommitChunks_(visitWrites);

    events.sort(function(a, b) { return a.time - b.time || a.row - b.row; });
    const summaries = calculateRouteStats_(definitions.routes, events);
    const now = new Date();
    let totalDistanceKm = 0;
    const statsWrites = summaries.map(function(state) {
      const user = usersByEmail[state.user];
      totalDistanceKm += state.completedCount * state.route.distanceKm;
      return firestoreWriteSet_('routeStats/' + routeStatsDocumentId_(user.userId, routeKey_(state.route.name)), {
        userId: user.userId, email: state.user, route: state.route.name,
        routeKey: routeKey_(state.route.name), distanceKm: state.route.distanceKm,
        visits: state.visits, completedCount: state.completedCount,
        openAttempts: state.openAttempts.map(function(attempt) { return attempt.progress; }),
        incompleteCount: state.incompleteCount, progressPoints: state.progressPoints,
        totalPoints: state.route.points.length, lastActivity: state.lastActivity,
        lastPoint: state.lastPoint, updatedAt: now
      });
    });
    firestoreCommitChunks_(statsWrites);
    firestoreSet_('aggregates/stats', {
      totalDistanceKm: totalDistanceKm, visitCount: visitWrites.length,
      updatedAt: now, migratedAt: now
    });
    return 'Migrace dokončena: ' + definitions.routes.length + ' tras, ' + pointWrites.length +
      ' bodů, ' + Object.keys(usersByEmail).length + ' uživatelů, ' + visitWrites.length +
      ' návštěv a ' + summaries.length + ' statistik.';
  } finally {
    lock.releaseLock();
  }
}

function syncFirestoreToSheets() {
  const lock = LockService.getUserLock();
  if (!lock.tryLock(1000)) return 'Synchronizace přeskočena: jiná synchronizace právě běží.';
  try {
    refreshDailyAdminReportIfNeeded_();
    const ss = spreadsheet_();
    const users = firestoreList_('users').sort(function(a, b) { return String(a.email).localeCompare(String(b.email)); });
    replaceSheetData_(ss, CONFIG.usersSheet, HEADERS.Users, users.map(function(user) {
      return [user.userId, user.email, user.status, asDate_(user.createdAt) || '', asDate_(user.verifiedAt) || '', asDate_(user.lastLoginAt) || '', user.role || ''];
    }), true);

    const authCodes = firestoreList_('authCodes').sort(function(a, b) { return dateNumber_(a.requestedAt) - dateNumber_(b.requestedAt); });
    replaceSheetData_(ss, CONFIG.authCodesSheet, HEADERS.AuthCodes, authCodes.map(function(item) {
      return [item.email, item.codeHash, asDate_(item.expiresAt) || '', Number(item.attempts) || 0, asDate_(item.requestedAt) || '', asDate_(item.usedAt) || ''];
    }), true);

    const sessions = firestoreList_('sessions').sort(function(a, b) { return dateNumber_(a.createdAt) - dateNumber_(b.createdAt); });
    replaceSheetData_(ss, CONFIG.sessionsSheet, HEADERS.Sessions, sessions.map(function(item) {
      return [item.tokenHash, item.userId, item.email, asDate_(item.createdAt) || '', asDate_(item.expiresAt) || '', asDate_(item.revokedAt) || '', asDate_(item.lastSeenAt) || ''];
    }), true);

    const visits = firestoreList_('visits').sort(function(a, b) { return dateNumber_(a.visitedAt) - dateNumber_(b.visitedAt); });
    replaceSheetData_(ss, CONFIG.logSheet, ['Datum', 'Codes', 'Popis', 'User', 'Barva'], visits.map(function(item) {
      return [asDate_(item.visitedAt) || '', item.code || '', item.description || '', item.email || '', item.color || item.route || ''];
    }), false);

    const stats = firestoreList_('routeStats').sort(function(a, b) {
      return String(a.email).localeCompare(String(b.email)) || String(a.route).localeCompare(String(b.route), 'cs');
    });
    replaceSheetData_(ss, CONFIG.statsSheet, HEADERS.RouteStats, stats.map(firestoreStatsToRow_), false);
    syncPointsToCodesSheet_(ss, firestoreList_('points'));
    PropertiesService.getScriptProperties().setProperty('SHEETS_SYNCED_AT', String(Date.now()));
    return 'Google Sheets synchronizován: ' + visits.length + ' návštěv a ' + stats.length + ' statistik.';
  } finally {
    lock.releaseLock();
  }
}


function firestoreStatsToRow_(item) {
  const visits = Array.isArray(item.visits) ? item.visits : [];
  const completedCount = Number(item.completedCount) || 0;
  const distanceKm = Number(item.distanceKm) || 0;
  return [
    item.email || '', item.route || '', distanceKm, Number(visits[0]) || 0,
    Number(visits[1]) || 0, Number(visits[2]) || 0, completedCount,
    completedCount * distanceKm, Number(item.incompleteCount) || 0,
    Number(item.progressPoints) || 0, Number(item.totalPoints) || 0,
    asDate_(item.lastActivity) || '', item.lastPoint || '', asDate_(item.updatedAt) || ''
  ];
}

function replaceSheetData_(ss, name, headers, rows, hidden) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  const oldRows = Math.max(0, sheet.getLastRow() - 1);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (oldRows > 0) sheet.getRange(2, 1, oldRows, headers.length).clearContent();
  if (rows.length > 0) sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  sheet.setFrozenRows(1);
  if (hidden && !sheet.isSheetHidden()) sheet.hideSheet();
}

function syncPointsToCodesSheet_(ss, points) {
  const sheet = ss.getSheetByName(CONFIG.codesSheet);
  if (!sheet || sheet.getLastRow() < 2) return;
  const byCode = {};
  points.forEach(function(point) { byCode[point.code] = point; });
  const rowCount = sheet.getLastRow() - 1;
  const codes = sheet.getRange(2, 1, rowCount, 1).getDisplayValues();
  const routeAndText = sheet.getRange(2, 4, rowCount, 2).getValues();
  const mapLinks = sheet.getRange(2, 6, rowCount, 1).getRichTextValues();
  const distances = sheet.getRange(2, 7, rowCount, 1).getValues();
  let changed = false;
  codes.forEach(function(row, index) {
    const point = byCode[String(row[0] || '')];
    if (!point) return;
    routeAndText[index] = [point.route || '', point.text || ''];
    const mapUrl = String(point.mapUrl || '');
    mapLinks[index] = [SpreadsheetApp.newRichTextValue().setText(mapUrl).setLinkUrl(mapUrl).build()];
    distances[index] = [Number(point.distanceKm) || 0];
    changed = true;
  });
  if (changed) {
    sheet.getRange(2, 4, rowCount, 2).setValues(routeAndText);
    sheet.getRange(2, 6, rowCount, 1).setRichTextValues(mapLinks);
    sheet.getRange(2, 7, rowCount, 1).setValues(distances);
  }
}

function buildRouteDefinitions_(values) {
  const routes = [];
  const byName = {};
  const byCode = {};
  for (let i = 1; i < values.length; i++) {
    const code = String(values[i][0] || '').trim();
    const routeName = String(values[i][3] || '').trim();
    if (!code || !routeName) continue;
    if (!byName[routeName]) {
      byName[routeName] = { name: routeName, distanceKm: parseDistance_(values[i][6]), points: [] };
      routes.push(byName[routeName]);
    }
    const route = byName[routeName];
    if (!route.distanceKm) route.distanceKm = parseDistance_(values[i][6]);
    const point = {
      code: code, route: route, index: route.points.length,
      text: String(values[i][4] || code), mapUrl: String(values[i][5] || '')
    };
    route.points.push(point);
    byCode[code] = point;
  }
  return { routes: routes, byCode: byCode };
}

function calculateRouteStats_(routes, events) {
  const states = {};
  events.forEach(function(event) {
    const key = event.user + '\n' + event.point.route.name;
    let state = states[key];
    if (!state) {
      state = states[key] = {
        user: event.user, route: event.point.route,
        visits: new Array(event.point.route.points.length).fill(0),
        completedCount: 0, openAttempts: [], lastActivity: '', lastPoint: ''
      };
    }
    const pointIndex = event.point.index;
    state.visits[pointIndex]++;
    state.lastActivity = event.date || '';
    state.lastPoint = event.point.text;
    const attemptResult = advanceRouteAttempt_(state.openAttempts, pointIndex, state.route.points.length);
    state.openAttempts = attemptResult.openAttempts;
    if (attemptResult.completed) state.completedCount++;
  });
  return Object.keys(states).map(function(key) {
    const state = states[key];
    state.incompleteCount = state.openAttempts.length;
    state.progressPoints = state.openAttempts.reduce(function(maximum, attempt) {
      return Math.max(maximum, routeAttemptProgress_(attempt, state.route.points.length));
    }, 0);
    return state;
  });
}

function firestoreProjectId_() {
  const projectId = PropertiesService.getScriptProperties().getProperty('FIRESTORE_PROJECT_ID') || CONFIG.firestoreProjectId;
  if (!projectId) throw new Error('FIRESTORE_PROJECT_ID není nastaven');
  return projectId;
}

function firestoreBaseUrl_() {
  return 'https://firestore.googleapis.com/v1/projects/' + encodeURIComponent(firestoreProjectId_()) +
    '/databases/' + encodeURIComponent(CONFIG.firestoreDatabase) + '/documents';
}

function firestoreRequest_(method, url, payload, allowNotFound) {
  const options = firestoreRequestOptions_(method, payload);
  const response = UrlFetchApp.fetch(url, options);
  return firestoreResponseBody_(response, allowNotFound);
}

function firestoreRequestOptions_(method, payload) {
  const options = {
    method: method,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  };
  if (payload !== undefined && payload !== null) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }
  return options;
}

function firestoreResponseBody_(response, allowNotFound) {
  const status = response.getResponseCode();
  if (allowNotFound && status === 404) return null;
  if (status < 200 || status >= 300) {
    throw new Error('Firestore HTTP ' + status + ': ' + response.getContentText().slice(0, 1000));
  }
  const text = response.getContentText();
  return text ? JSON.parse(text) : {};
}

function firestoreFetchAll_(requests) {
  if (!requests.length) return [];
  const responses = UrlFetchApp.fetchAll(requests.map(function(request) {
    const options = firestoreRequestOptions_(request.method, request.payload);
    options.url = request.url;
    return options;
  }));
  return responses.map(function(response, index) {
    return firestoreResponseBody_(response, Boolean(requests[index].allowNotFound));
  });
}

function firestoreGet_(path) {
  const doc = firestoreRequest_('get', firestoreBaseUrl_() + '/' + path, null, true);
  return doc ? firestoreDocumentData_(doc) : null;
}

function firestoreGetMany_(paths) {
  const documents = firestoreFetchAll_(paths.map(function(path) {
    return { method: 'get', url: firestoreBaseUrl_() + '/' + path, allowNotFound: true };
  }));
  return documents.map(function(document) {
    return document ? firestoreDocumentData_(document) : null;
  });
}

function firestoreSet_(path, data) {
  const document = firestoreRequest_('patch', firestoreBaseUrl_() + '/' + path, {
    fields: firestoreFields_(data)
  }, false);
  return firestoreDocumentData_(document);
}

function firestoreList_(collectionPath) {
  const all = [];
  let pageToken = '';
  do {
    let url = firestoreBaseUrl_() + '/' + collectionPath + '?pageSize=500';
    if (pageToken) url += '&pageToken=' + encodeURIComponent(pageToken);
    const result = firestoreRequest_('get', url, null, false);
    (result.documents || []).forEach(function(doc) { all.push(firestoreDocumentData_(doc)); });
    pageToken = result.nextPageToken || '';
  } while (pageToken);
  return all;
}

function firestoreQuery_(collectionId, where, options) {
  const query = firestoreStructuredQuery_(collectionId, where, options);
  const result = firestoreRequest_('post', firestoreBaseUrl_() + ':runQuery', { structuredQuery: query }, false);
  return firestoreQueryDocuments_(result);
}

function firestoreQueryAndGet_(collectionId, where, options, documentPath) {
  const query = firestoreStructuredQuery_(collectionId, where, options);
  const results = firestoreFetchAll_([
    { method: 'post', url: firestoreBaseUrl_() + ':runQuery', payload: { structuredQuery: query } },
    { method: 'get', url: firestoreBaseUrl_() + '/' + documentPath, allowNotFound: true }
  ]);
  return {
    documents: firestoreQueryDocuments_(results[0]),
    document: results[1] ? firestoreDocumentData_(results[1]) : null
  };
}

function firestoreStructuredQuery_(collectionId, where, options) {
  options = options || {};
  const query = { from: [{ collectionId: collectionId }] };
  if (where) query.where = where;
  if (options.orderBy) query.orderBy = options.orderBy;
  if (options.offset) query.offset = options.offset;
  if (options.limit) query.limit = options.limit;
  return query;
}

function firestoreQueryDocuments_(result) {
  return (result || []).filter(function(row) { return row.document; }).map(function(row) {
    return firestoreDocumentData_(row.document);
  });
}

function firestoreCommit_(writes) {
  if (!writes.length) return;
  const root = firestoreBaseUrl_().replace(/\/documents$/, '');
  firestoreRequest_('post', root + '/documents:commit', { writes: writes }, false);
}

function firestoreCommitChunks_(writes) {
  for (let i = 0; i < writes.length; i += 400) firestoreCommit_(writes.slice(i, i + 400));
}

function firestoreWriteSet_(path, data) {
  return {
    update: {
      name: firestoreBaseUrl_().replace('https://firestore.googleapis.com/v1/', '') + '/' + path,
      fields: firestoreFields_(data)
    }
  };
}

function firestoreWriteCreate_(path, data) {
  const write = firestoreWriteSet_(path, data);
  write.currentDocument = { exists: false };
  return write;
}


function cacheGetJson_(key) {
  try {
    const value = CacheService.getScriptCache().get(key);
    return value ? JSON.parse(value) : null;
  } catch (_) {
    return null;
  }
}

function cachePutJson_(key, value, seconds) {
  try {
    CacheService.getScriptCache().put(key, JSON.stringify(value), seconds);
  } catch (_) {
    // Cache je pouze optimalizace; jeho výpadek nesmí zablokovat aplikaci.
  }
}

function firestoreFields_(object) {
  const fields = {};
  Object.keys(object || {}).forEach(function(key) { fields[key] = firestoreValue_(object[key]); });
  return fields;
}

function firestoreValue_(value) {
  if (value === null || value === undefined || value === '') {
    if (value === '') return { stringValue: '' };
    return { nullValue: null };
  }
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(firestoreValue_) } };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return { integerValue: String(value) };
    return { doubleValue: value };
  }
  if (typeof value === 'object') return { mapValue: { fields: firestoreFields_(value) } };
  return { stringValue: String(value) };
}

function firestoreDocumentData_(document) {
  const data = firestoreDecodeFields_(document.fields || {});
  data.__name = document.name || '';
  data.__id = data.__name.split('/').pop();
  data.__createTime = document.createTime || '';
  data.__updateTime = document.updateTime || '';
  return data;
}

function firestoreDecodeFields_(fields) {
  const object = {};
  Object.keys(fields || {}).forEach(function(key) { object[key] = firestoreDecodeValue_(fields[key]); });
  return object;
}

function firestoreDecodeValue_(value) {
  if ('nullValue' in value) return null;
  if ('stringValue' in value) return value.stringValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('timestampValue' in value) return new Date(value.timestampValue);
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(firestoreDecodeValue_);
  if ('mapValue' in value) return firestoreDecodeFields_(value.mapValue.fields || {});
  return null;
}

function parseRequest_(e) {
  if (!e) return {};
  if (e.postData && String(e.postData.type || '').toLowerCase().indexOf('application/json') === 0) {
    return JSON.parse(e.postData.contents || '{}');
  }
  return e.parameter || {};
}

function sheetValues_(ss, name) {
  const sheet = ss.getSheetByName(name);
  return sheet ? sheet.getDataRange().getValues() : [];
}

function routeKey_(value) {
  const normalized = String(value || '').trim().toLowerCase();
  const map = { 'červená': 'cervena', 'černá': 'cerna', 'modrá': 'modra', 'oranžová': 'oranzova', 'žlutá': 'zluta', 'hnědá': 'hneda', 'zelená': 'zelena' };
  if (map[normalized]) return map[normalized];
  return normalized.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function routeStatsDocumentId_(userId, routeKey) {
  return String(userId) + '__' + String(routeKey);
}

function emailDocumentId_(email) {
  return sha256Hex_('email:' + normalizeEmail_(email));
}

function sha256Hex_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value)).map(function(byte) {
    const unsigned = byte < 0 ? byte + 256 : byte;
    return ('0' + unsigned.toString(16)).slice(-2);
  }).join('');
}

function normalizeEmail_(value) { return String(value || '').trim().toLowerCase(); }
function normalizeRole_(value) { return String(value || '').trim().toLowerCase(); }
function isValidEmail_(email) { return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }

function generateOtp_() {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + ':' + new Date().getTime());
  const number = ((bytes[0] & 255) << 24) | ((bytes[1] & 255) << 16) | ((bytes[2] & 255) << 8) | (bytes[3] & 255);
  return String(Math.abs(number) % 1000000).padStart(6, '0');
}

function generateToken_() {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    Utilities.getUuid() + ':' + Utilities.getUuid() + ':' + new Date().getTime()
  )).replace(/=+$/, '');
}

function hash_(value) {
  const pepper = PropertiesService.getScriptProperties().getProperty('AUTH_PEPPER');
  if (!pepper) throw new Error('AUTH_PEPPER není nastaven');
  const signature = Utilities.computeHmacSha256Signature(String(value), pepper);
  return signature.map(function(byte) {
    const unsigned = byte < 0 ? byte + 256 : byte;
    return ('0' + unsigned.toString(16)).slice(-2);
  }).join('');
}

function constantTimeEqual_(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

function asDate_(value) {
  if (!value) return null;
  if (value instanceof Date && !isNaN(value.getTime())) return value;
  const date = new Date(value);
  return isNaN(date.getTime()) ? null : date;
}

function dateNumber_(value) {
  const date = asDate_(value);
  return date ? date.getTime() : 0;
}

function parseDistance_(value) {
  if (typeof value === 'number') return value;
  return Number(String(value || '').replace(',', '.')) || 0;
}

function formatDateTime_(value) {
  const date = asDate_(value);
  return date ? Utilities.formatDate(date, Session.getScriptTimeZone(), 'd.M.yyyy HH:mm') : '';
}

function spreadsheet_() { return SpreadsheetApp.openById(CONFIG.spreadsheetId); }

function json_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}

function sanitizeForLog_(data) {
  return { action: data && data.action, email: data && normalizeEmail_(data.email), code: data && data.code };
}

function logError_(where, err, extra) {
  console.error(JSON.stringify({
    at: new Date().toISOString(), where: where,
    error: String(err && err.stack || err), extra: extra || null
  }));
}

function generujKod() {
  const znaky = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let kod = '';
  for (let i = 0; i < 12; i++) kod += znaky.charAt(Math.floor(Math.random() * znaky.length));
  return kod;
}
