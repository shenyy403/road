const express = require('express');
const cors = require('cors');
const session = require('express-session');
const db = require('./database');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const archiver = require('archiver');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
    origin: true,
    credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

app.use(session({
    secret: 'road-draw-secret-key-2024',
    resave: false,
    saveUninitialized: true,
    cookie: {
        maxAge: 24 * 60 * 60 * 1000,
        httpOnly: true,
        secure: false
    }
}));

// ============ 工具函数 ============
function logOperation(username, action, details = '', ip = '') {
    db.run(
        'INSERT INTO operation_logs (username, action, details, ip) VALUES (?, ?, ?, ?)',
        [username, action, details, ip],
        (err) => { if (err) console.error('日志记录失败:', err); }
    );
}

function getClientIp(req) {
    return req.headers['x-forwarded-for'] ||
        req.connection.remoteAddress ||
        req.socket.remoteAddress ||
        '';
}

function getWeekKey(date = new Date()) {
    const d = new Date(date);
    const year = d.getFullYear();
    const jan1 = new Date(year, 0, 1);
    const days = Math.floor((d - jan1) / 86400000);
    const week = Math.ceil((days + jan1.getDay() + 1) / 7);
    return `${year}-W${String(week).padStart(2, '0')}`;
}

function getTodayChina() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// ============ 获取本周一到周五的日期（兜底用） ============
function getWeekDatesFromToday() {
    const today = new Date();
    const todayDay = today.getDay();

    let daysToMonday;
    if (todayDay === 0) {
        daysToMonday = 6;
    } else {
        daysToMonday = todayDay - 1;
    }

    const monday = new Date(today);
    monday.setDate(today.getDate() - daysToMonday);
    monday.setHours(0, 0, 0, 0);

    const dates = [];
    for (let i = 0; i < 5; i++) {
        const d = new Date(monday);
        d.setDate(monday.getDate() + i);
        const yearStr = d.getFullYear();
        const monthStr = String(d.getMonth() + 1).padStart(2, '0');
        const dayStr = String(d.getDate()).padStart(2, '0');
        dates.push(`${yearStr}-${monthStr}-${dayStr}`);
    }
    return dates;
}

function getDayOfWeek(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return days[d.getDay()];
}

function requireAuth(req, res, next) {
    if (!req.session.user) {
        return res.status(401).json({ error: '请先登录' });
    }
    next();
}

// Promise 包装，方便用 async/await
function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
    });
}
function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
    });
}
function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

// ============ 登录相关 ============
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const ip = getClientIp(req);

    if (!username || !password) {
        return res.status(400).json({ success: false, message: '请输入用户名和密码' });
    }

    db.get('SELECT * FROM users WHERE username = ? AND password = ?', [username, password], (err, user) => {
        if (err) return res.status(500).json({ success: false, message: '数据库错误' });

        if (!user) {
            logOperation(username, '登录失败', '用户名或密码错误', ip);
            return res.status(401).json({ success: false, message: '用户名或密码错误' });
        }

        req.session.user = {
            id: user.id,
            username: user.username,
            role: user.role
        };

        logOperation(username, '登录成功', '', ip);
        res.json({ success: true, user: { username: user.username, role: user.role } });
    });
});

app.post('/api/logout', (req, res) => {
    if (req.session.user) {
        logOperation(req.session.user.username, '登出', '', getClientIp(req));
    }
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/check-auth', (req, res) => {
    if (req.session.user) {
        res.json({ loggedIn: true, user: req.session.user });
    } else {
        res.json({ loggedIn: false });
    }
});

// ============ 用户管理 ============
app.get('/api/users', requireAuth, (req, res) => {
    if (req.session.user.role !== 'admin') {
        return res.status(403).json({ error: '需要管理员权限' });
    }
    db.all('SELECT id, username, role, created_at FROM users', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/users', requireAuth, (req, res) => {
    if (req.session.user.role !== 'admin') {
        return res.status(403).json({ error: '需要管理员权限' });
    }
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: '用户名和密码不能为空' });
    }
    db.run('INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
        [username, password, 'user'],
        function(err) {
            if (err) {
                if (err.message.includes('UNIQUE')) {
                    return res.status(400).json({ error: '用户名已存在' });
                }
                return res.status(500).json({ error: err.message });
            }
            logOperation(req.session.user.username, '添加用户', `添加用户: ${username}`, getClientIp(req));
            res.json({ success: true, id: this.lastID });
        }
    );
});

app.post('/api/users/batch', requireAuth, (req, res) => {
    if (req.session.user.role !== 'admin') {
        return res.status(403).json({ error: '需要管理员权限' });
    }
    const { users } = req.body;
    if (!users || !Array.isArray(users) || users.length === 0) {
        return res.status(400).json({ error: '请提供用户列表' });
    }
    const stmt = db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)');
    let successCount = 0, failCount = 0;
    db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        users.forEach(u => {
            if (u.username && u.password) {
                try {
                    stmt.run(u.username.trim(), u.password.trim(), 'user');
                    successCount++;
                } catch (e) { failCount++; }
            } else { failCount++; }
        });
        stmt.finalize();
        db.run('COMMIT');
    });
    logOperation(req.session.user.username, '批量添加用户', `成功: ${successCount}, 失败: ${failCount}`, getClientIp(req));
    res.json({ success: true, added: successCount, failed: failCount });
});

app.delete('/api/users/:id', requireAuth, (req, res) => {
    if (req.session.user.role !== 'admin') {
        return res.status(403).json({ error: '需要管理员权限' });
    }
    const { id } = req.params;
    if (id == req.session.user.id) {
        return res.status(400).json({ error: '不能删除自己' });
    }
    db.get('SELECT username FROM users WHERE id = ?', [id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        db.run('DELETE FROM users WHERE id = ?', [id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            logOperation(req.session.user.username, '删除用户', `删除用户: ${row ? row.username : '未知'}`, getClientIp(req));
            res.json({ success: true, deleted: this.changes });
        });
    });
});

// ============ 资源管理 ============
app.get('/api/resources', requireAuth, (req, res) => {
    const { planKey } = req.query;
    let sql = 'SELECT * FROM resources';
    let params = [];
    if (planKey) {
        sql += ' WHERE plan_key = ?';
        params.push(planKey);
    }
    sql += ' ORDER BY id';
    db.all(sql, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// ============ 资源方案管理 ============
app.get('/api/resource-plans', requireAuth, (req, res) => {
    if (req.session.user.role !== 'admin') {
        return res.status(403).json({ error: '需要管理员权限' });
    }
    db.all('SELECT * FROM resource_plans ORDER BY id', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/resource-plans/activate', requireAuth, (req, res) => {
    if (req.session.user.role !== 'admin') {
        return res.status(403).json({ error: '需要管理员权限' });
    }
    const { planKey } = req.body;
    const username = req.session.user.username;
    const ip = getClientIp(req);

    if (!planKey) {
        return res.status(400).json({ error: '请选择方案' });
    }

    db.serialize(() => {
        db.run('UPDATE resource_plans SET is_active = 0 WHERE is_active = 1');
        db.run('UPDATE resource_plans SET is_active = 1 WHERE plan_key = ?', [planKey]);

        logOperation(username, '切换资源方案', `切换到: ${planKey}`, ip);
        res.json({ success: true, planKey: planKey });
    });
});

// ============ 获取当前激活方案 ============
app.get('/api/active-plan', requireAuth, (req, res) => {
    db.get('SELECT * FROM resource_plans WHERE is_active = 1', (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row || { plan_key: 'plan_a', plan_name: '方案A（70个资源）' });
    });
});

// ============ 轮次配置（管理员选日期） ============
app.post('/api/draw-rounds', requireAuth, (req, res) => {
    if (req.session.user.role !== 'admin') {
        return res.status(403).json({ error: '需要管理员权限' });
    }
    const { roundKey, planKey, dates } = req.body;
    if (!roundKey || !Array.isArray(dates) || dates.length === 0) {
        return res.status(400).json({ error: '请提供轮次标识和日期列表' });
    }
    db.run(
        `INSERT INTO draw_rounds (round_key, plan_key, dates, created_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(round_key) DO UPDATE SET
           plan_key = excluded.plan_key,
           dates = excluded.dates`,
        [roundKey, planKey || 'plan_a', JSON.stringify(dates), req.session.user.username],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            logOperation(req.session.user.username, '保存轮次',
                `${roundKey}: ${dates.join(',')}`, getClientIp(req));
            res.json({ success: true });
        }
    );
});

app.get('/api/draw-rounds/:roundKey', requireAuth, (req, res) => {
    db.get('SELECT * FROM draw_rounds WHERE round_key = ?', [req.params.roundKey], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.json(null);
        res.json({ ...row, dates: JSON.parse(row.dates) });
    });
});

app.get('/api/draw-rounds', requireAuth, (req, res) => {
    if (req.session.user.role !== 'admin') {
        return res.status(403).json({ error: '需要管理员权限' });
    }
    db.all('SELECT * FROM draw_rounds ORDER BY created_at DESC', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows.map(r => ({ ...r, dates: JSON.parse(r.dates) })));
    });
});

// ============ 自定义方案（管理员勾选资源） ============
app.get('/api/custom-plans', requireAuth, (req, res) => {
    if (req.session.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
    db.all('SELECT * FROM custom_plans ORDER BY created_at DESC', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows.map(r => ({ ...r, resource_ids: JSON.parse(r.resource_ids) })));
    });
});

app.post('/api/custom-plans', requireAuth, (req, res) => {
    if (req.session.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
    const { planName, resourceIds } = req.body;
    if (!planName || !Array.isArray(resourceIds) || resourceIds.length === 0) {
        return res.status(400).json({ error: '请提供方案名和资源列表' });
    }
    db.run(
        'INSERT INTO custom_plans (plan_name, resource_ids, created_by) VALUES (?, ?, ?)',
        [planName, JSON.stringify(resourceIds), req.session.user.username],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, id: this.lastID, planKey: 'custom_' + this.lastID });
        }
    );
});

app.delete('/api/custom-plans/:id', requireAuth, (req, res) => {
    if (req.session.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
    db.run('DELETE FROM custom_plans WHERE id = ?', [req.params.id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, deleted: this.changes });
    });
});

// ============ 抽取记录 ============
app.get('/api/records/:weekKey', requireAuth, (req, res) => {
    const { weekKey } = req.params;
    db.all(
        `SELECT r.*, dr.draw_date, dr.week_key, dr.assigned_to
         FROM draw_records dr 
         JOIN resources r ON dr.resource_id = r.id 
         WHERE dr.week_key = ? 
         ORDER BY dr.draw_date ASC, r.id`,
        [weekKey],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });

            const grouped = {};
            rows.forEach(row => {
                if (!grouped[row.draw_date]) {
                    grouped[row.draw_date] = [];
                }
                grouped[row.draw_date].push(row);
            });

            res.json({
                records: rows,
                grouped: grouped,
                total: rows.length
            });
        }
    );
});

// ============ 获取当前用户今日抽取 ============
app.get('/api/my-today-draw', requireAuth, (req, res) => {
    const username = req.session.user.username;
    const todayStr = getTodayChina();
    const weekKey = getWeekKey();

    db.all(
        `SELECT dr.resource_id, r.name, r.type, r.type_label, r.responsible, r.camera, r.area,
                dr.draw_date, dr.assigned_to
         FROM draw_records dr
         JOIN resources r ON dr.resource_id = r.id
         WHERE dr.week_key = ?
           AND dr.assigned_to = ?
           AND dr.draw_date = ?
         ORDER BY r.type DESC, dr.draw_date`,
        [weekKey, username, todayStr],
        (err, rows) => {
            if (err) {
                console.error('查询今日抽取失败:', err);
                return res.status(500).json({ error: err.message });
            }

            const result = {
                cross: rows.filter(r => r.type === 'cross'),
                road: rows.filter(r => r.type === 'road')
            };
            res.json(result);
        }
    );
});

// ============ 保存参与用户 ============
app.post('/api/week-participants', requireAuth, (req, res) => {
    if (req.session.user.role !== 'admin') {
        return res.status(403).json({ error: '需要管理员权限' });
    }

    const { participants, weekKey: bodyWeekKey } = req.body;
    const weekKey = bodyWeekKey || getWeekKey();
    const username = req.session.user.username;
    const ip = getClientIp(req);

    if (!participants || !Array.isArray(participants)) {
        return res.status(400).json({ error: '请提供参与者列表' });
    }

    db.serialize(() => {
        db.run('DELETE FROM user_participants WHERE week_key = ?', [weekKey]);

        const stmt = db.prepare(
            'INSERT INTO user_participants (week_key, username, is_participating) VALUES (?, ?, ?)'
        );
        participants.forEach(p => {
            stmt.run(weekKey, p.username, p.isParticipating ? 1 : 0);
        });
        stmt.finalize();

        logOperation(username, '更新参与用户', `更新了 ${participants.length} 个用户`, ip);
        res.json({ success: true, count: participants.length });
    });
});

// ============ 获取参与用户 ============
app.get('/api/week-participants', requireAuth, (req, res) => {
    const weekKey = req.query.weekKey || getWeekKey();

    db.all(
        `SELECT username, is_participating FROM user_participants WHERE week_key = ?`,
        [weekKey],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });

            if (rows.length === 0) {
                db.all(
                    `SELECT username FROM users WHERE role = 'user' ORDER BY username`,
                    (err2, users) => {
                        if (err2) return res.status(500).json({ error: err2.message });
                        res.json({
                            weekKey: weekKey,
                            participants: users.map(u => ({
                                username: u.username,
                                isParticipating: true
                            }))
                        });
                    }
                );
            } else {
                res.json({
                    weekKey: weekKey,
                    participants: rows.map(r => ({
                        username: r.username,
                        isParticipating: r.is_participating === 1
                    }))
                });
            }
        }
    );
});

// ============ 均衡抽取（按轮次日期 + 工作量尽可能平均） ============
app.post('/api/draw-week', requireAuth, async (req, res) => {
    const { weekKey, planKey, roundKey } = req.body;
    const username = req.session.user.username;
    const ip = getClientIp(req);

    if (!weekKey) {
        return res.status(400).json({ error: '缺少必要参数 weekKey' });
    }

    try {
        // 1. 已有记录？
        const exist = await dbGet('SELECT COUNT(*) as count FROM draw_records WHERE week_key = ?', [weekKey]);
        if (exist.count > 0) {
            return res.json({ success: false, message: '⚠️ 本轮已有抽取记录，请先重置再重新抽取！' });
        }

        // 2. 日期：优先用轮次配置，否则回退到周一~周五
        let dates;
        if (roundKey) {
            const round = await dbGet('SELECT dates FROM draw_rounds WHERE round_key = ?', [roundKey]);
            dates = round ? JSON.parse(round.dates) : getWeekDatesFromToday();
        } else {
            dates = getWeekDatesFromToday();
        }
        if (!dates || dates.length === 0) {
            return res.status(400).json({ error: '没有可用的抽取日期' });
        }

        // 3. 参与用户
        const participantRows = await dbAll(
            'SELECT username, is_participating FROM user_participants WHERE week_key = ?', [weekKey]);
        let activeUsers;
        if (participantRows.length > 0) {
            activeUsers = participantRows.filter(r => r.is_participating === 1).map(r => r.username);
        } else {
            const allUsers = await dbAll("SELECT username FROM users WHERE role = 'user'");
            activeUsers = allUsers.map(r => r.username);
        }
        if (activeUsers.length === 0) {
            return res.json({ success: false, message: '⚠️ 没有参与用户！' });
        }

        // 4. 当前方案
        const planRow = await dbGet('SELECT plan_key FROM resource_plans WHERE is_active = 1');
        const currentPlan = planKey || (planRow ? planRow.plan_key : 'plan_a');

        // 5. 资源：支持 custom_<id>
        let allResources;
        if (String(currentPlan).startsWith('custom_')) {
            const id = currentPlan.replace('custom_', '');
            const cp = await dbGet('SELECT resource_ids FROM custom_plans WHERE id = ?', [id]);
            if (!cp) return res.status(400).json({ error: '自定义方案不存在' });
            const ids = JSON.parse(cp.resource_ids);
            const placeholders = ids.map(() => '?').join(',');
            allResources = await dbAll(`SELECT * FROM resources WHERE id IN (${placeholders})`, ids);
        } else {
            allResources = await dbAll('SELECT * FROM resources WHERE plan_key = ?', [currentPlan]);
        }

        const shuffledCrosses = allResources.filter(r => r.type === 'cross').sort(() => Math.random() - 0.5);
        const shuffledRoads = allResources.filter(r => r.type === 'road').sort(() => Math.random() - 0.5);

        // 6. 贪心均衡分配：路口 1.0，路段 0.5
        const userAssignments = activeUsers.map(u => ({
            username: u, crossCount: 0, roadCount: 0, totalWork: 0, crosses: [], roads: []
        }));

        const allItems = [
            ...shuffledCrosses.map(r => ({ r, w: 1.0 })),
            ...shuffledRoads.map(r => ({ r, w: 0.5 }))
        ].sort((a, b) => b.w - a.w);

        for (const item of allItems) {
            userAssignments.sort((a, b) =>
                (a.totalWork - b.totalWork) ||
                ((a.crossCount + a.roadCount) - (b.crossCount + b.roadCount))
            );
            const u = userAssignments[0];
            if (item.r.type === 'cross') { u.crosses.push(item.r); u.crossCount++; }
            else { u.roads.push(item.r); u.roadCount++; }
            u.totalWork += item.w;
        }

        // 7. 资源 -> 用户 映射
        const resourceToUser = {};
        userAssignments.forEach(a => {
            a.crosses.forEach(c => { resourceToUser[c.id] = a.username; });
            a.roads.forEach(r => { resourceToUser[r.id] = a.username; });
        });

        // 8. 按天平均分
        const allCrossesToAssign = [];
        const allRoadsToAssign = [];
        userAssignments.forEach(a => {
            allCrossesToAssign.push(...a.crosses);
            allRoadsToAssign.push(...a.roads);
        });
        allCrossesToAssign.sort(() => Math.random() - 0.5);
        allRoadsToAssign.sort(() => Math.random() - 0.5);

        const totalDays = dates.length;
        const baseCrossPerDay = Math.floor(allCrossesToAssign.length / totalDays);
        const remainCrosses = allCrossesToAssign.length - baseCrossPerDay * totalDays;
        const baseRoadPerDay = Math.floor(allRoadsToAssign.length / totalDays);
        const remainRoads = allRoadsToAssign.length - baseRoadPerDay * totalDays;

        let crossIdx = 0, roadIdx = 0;
        const allRecords = [];
        const dailyStats = [];

        dates.forEach((date, dayIndex) => {
            let dayCrossCount = baseCrossPerDay + (dayIndex < remainCrosses ? 1 : 0);
            const dayCrosses = allCrossesToAssign.slice(crossIdx, crossIdx + dayCrossCount);
            crossIdx += dayCrossCount;

            let dayRoadCount = baseRoadPerDay + (dayIndex < remainRoads ? 1 : 0);
            const dayRoads = allRoadsToAssign.slice(roadIdx, roadIdx + dayRoadCount);
            roadIdx += dayRoadCount;

            const dayRecords = [];
            dayCrosses.forEach(c => dayRecords.push({
                resource_id: c.id, draw_date: date, week_key: weekKey,
                assigned_to: resourceToUser[c.id] || ''
            }));
            dayRoads.forEach(r => dayRecords.push({
                resource_id: r.id, draw_date: date, week_key: weekKey,
                assigned_to: resourceToUser[r.id] || ''
            }));

            allRecords.push(...dayRecords);
            dailyStats.push({
                date, dayOfWeek: getDayOfWeek(date),
                roadCount: dayRoads.length, crossCount: dayCrosses.length,
                total: dayRecords.length
            });
        });

        if (allRecords.length === 0) {
            return res.json({ success: false, message: '⚠️ 没有可用的资源！' });
        }

        // 9. 事务写入
        await new Promise((resolve, reject) => {
            db.serialize(() => {
                db.run('BEGIN TRANSACTION');
                const stmt = db.prepare(
                    'INSERT INTO draw_records (resource_id, draw_date, week_key, assigned_to) VALUES (?, ?, ?, ?)'
                );
                allRecords.forEach(r => stmt.run(r.resource_id, r.draw_date, r.week_key, r.assigned_to));
                stmt.finalize();
                db.run('COMMIT', (e) => e ? reject(e) : resolve());
            });
        });

        const workReport = userAssignments
            .slice().sort((a, b) => a.username.localeCompare(b.username, 'zh'))
            .map(a => `${a.username}: 路口${a.crossCount} + 路段${a.roadCount} = ${a.totalWork.toFixed(1)}`)
            .join(' | ');

        const detailMsg = dailyStats.map(d =>
            `${d.date}(${d.dayOfWeek}): 路段${d.roadCount} + 路口${d.crossCount} = ${d.total}`
        ).join('\n');

        logOperation(username, '批量抽取',
            `共${allRecords.length}条，${userAssignments.length}人，方案:${currentPlan}，日期:${dates.join(',')}`, ip);

        res.json({
            success: true,
            message: `✅ 抽取完成！共 ${allRecords.length} 个点位\n\n📊 工作量分配：\n${workReport}\n\n📅 每日分布：\n${detailMsg}`,
            total: allRecords.length,
            days: dates.length,
            dailyStats,
            userWorkload: userAssignments.map(a => ({
                username: a.username, crossCount: a.crossCount,
                roadCount: a.roadCount, totalWork: a.totalWork
            })),
            planKey: currentPlan,
            dates
        });
    } catch (e) {
        console.error('抽取失败:', e);
        res.status(500).json({ error: e.message });
    }
});

// ============ 重置本轮 ============
app.delete('/api/reset/:weekKey', requireAuth, (req, res) => {
    const { weekKey } = req.params;
    const username = req.session.user.username;
    const ip = getClientIp(req);
    db.run('DELETE FROM draw_records WHERE week_key = ?', [weekKey], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        logOperation(username, '重置本轮', `删除 ${this.changes} 条抽取记录`, ip);
        res.json({ success: true, deleted: this.changes });
    });
});

// ===== 导入单条抽取记录 =====
app.post('/api/import-draw-record', requireAuth, (req, res) => {
    if (req.session.user.role !== 'admin') {
        return res.status(403).json({ error: '需要管理员权限' });
    }

    const { resource_id, draw_date, week_key, assigned_to } = req.body;
    if (!resource_id || !draw_date || !week_key) {
        return res.status(400).json({ error: '缺少必要参数' });
    }

    db.run(
        'INSERT INTO draw_records (resource_id, draw_date, week_key, assigned_to) VALUES (?, ?, ?, ?)',
        [resource_id, draw_date, week_key, assigned_to || ''],
        function(err) {
            if (err) {
                console.error('导入失败:', err);
                return res.status(500).json({ error: err.message });
            }
            res.json({ success: true, id: this.lastID });
        }
    );
});

// ============ 测评数据相关 ============
app.get('/api/my-assessments-today', requireAuth, (req, res) => {
    const username = req.session.user.username;
    const todayStr = req.query.date || getTodayChina();

    db.all(
        `SELECT * FROM assessments
         WHERE evaluator = ?
           AND assessment_date = ?
         ORDER BY type DESC, row_index`,
        [username, todayStr],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            // 解析 image_urls
            rows.forEach(r => {
                try { r.imageUrl = JSON.parse(r.image_urls || '[]'); }
                catch (e) { r.imageUrl = []; }
            });
            res.json(rows);
        }
    );
});

// ============ 判断某行是否需要强制传图 ============
function needImageForRow(row) {
    let needImage = false, imageType = '';
    if (row.type === 'cross') {
        const c = parseFloat(row.compliance_rate) || 0;
        const y = parseFloat(row.yield_rate) || 0;
        if (c > 0 && c < 98) { needImage = true; imageType = '遵章率'; }
        if (y > 0 && y < 98) { needImage = true; imageType = imageType ? imageType + '/礼让率' : '礼让率'; }
    } else {
        const y = parseFloat(row.yield_rate) || 0;
        if (y > 0 && y < 98) { needImage = true; imageType = '礼让率'; }
    }
    return { needImage, imageType };
}

app.post('/api/assessments/submit', requireAuth, async (req, res) => {
    const username = req.session.user.username;
    const todayStr = req.body.date || getTodayChina();
    const { assessments } = req.body;

    if (!assessments || !Array.isArray(assessments) || assessments.length === 0) {
        return res.status(400).json({ error: '请提供测评数据' });
    }

    // 先做整体校验：任何一行 98% 以下且没图，直接拒绝
    const errors = [];
    assessments.forEach((row, idx) => {
        if (!row.name || !row.name.trim()) return;
        const urls = Array.isArray(row.imageUrl)
            ? row.imageUrl
            : (row.imageUrl ? [row.imageUrl] : []);
        const { needImage, imageType } = needImageForRow(row);
        if (needImage && urls.length === 0) {
            const typeLabel = row.type === 'cross' ? '路口' : '路段';
            errors.push(`第${idx + 1}行 ${typeLabel}「${row.name}」${imageType}低于98%，必须上传图片`);
        }
    });
    if (errors.length > 0) {
        return res.status(400).json({
            success: false,
            error: '强制传图校验未通过',
            errors
        });
    }

    let successCount = 0;
    let errorCount = 0;
    const ip = getClientIp(req);

    try {
        for (const row of assessments) {
            if (!row.name || row.name.trim() === '') continue;
            if (row.evaluator && row.evaluator !== username) { errorCount++; continue; }

            const urls = Array.isArray(row.imageUrl)
                ? row.imageUrl
                : (row.imageUrl ? [row.imageUrl] : []);
            const imageUrlsJson = JSON.stringify(urls);
            const { imageType } = needImageForRow(row);

            const existing = await dbGet(
                `SELECT id FROM assessments 
                 WHERE name = ? AND evaluator = ? AND assessment_date = ? AND type = ? AND row_index = ?`,
                [row.name, username, todayStr, row.type, row.row_index || 0]
            );

            let assessmentId;
            if (existing) {
                await dbRun(`
                    UPDATE assessments SET
                        paixu = ?, camera = ?, direction = ?,
                        time_start = ?, time_end = ?,
                        non_motor_count = ?, reverse_count = ?, red_light_count = ?,
                        stop_line_count = ?, no_crosswalk_count = ?, other_count = ?,
                        total = ?, compliance_rate = ?,
                        right_turn_count = ?, no_yield_count = ?, yield_rate = ?,
                        illegal_count = ?, remark = ?,
                        non_motor_total = ?, wrong_lane_count = ?, compliance_rate_non = ?,
                        parking_violation = ?, jaywalk_count = ?,
                        crosswalk_total = ?, no_yield_cross = ?, compliance_rate_cross = ?,
                        image_urls = ?,
                        updated_at = datetime('now')
                    WHERE id = ?
                `, [
                    row.paixu || '', row.camera || '', row.direction || '',
                    row.time_start || '', row.time_end || '',
                    row.non_motor_count || '', row.reverse_count || '', row.red_light_count || '',
                    row.stop_line_count || '', row.no_crosswalk_count || '', row.other_count || '',
                    row.total || '', row.compliance_rate || '',
                    row.right_turn_count || '', row.no_yield_count || '', row.yield_rate || '',
                    row.illegal_count || '', row.remark || '',
                    row.non_motor_total || '', row.wrong_lane_count || '', row.compliance_rate_non || '',
                    row.parking_violation || '', row.jaywalk_count || '',
                    row.crosswalk_total || '', row.no_yield_cross || '', row.compliance_rate_cross || '',
                    imageUrlsJson,
                    existing.id
                ]);
                assessmentId = existing.id;
            } else {
                const result = await dbRun(`
                    INSERT INTO assessments (
                        type, row_index, paixu, name, camera, direction,
                        time_start, time_end,
                        non_motor_count, reverse_count, red_light_count,
                        stop_line_count, no_crosswalk_count, other_count,
                        total, compliance_rate,
                        right_turn_count, no_yield_count, yield_rate,
                        illegal_count, evaluator, remark,
                        non_motor_total, wrong_lane_count, compliance_rate_non,
                        parking_violation, jaywalk_count,
                        crosswalk_total, no_yield_cross, compliance_rate_cross,
                        image_urls,
                        assessment_date
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    row.type || 'cross', row.row_index || 0, row.paixu || '', row.name || '',
                    row.camera || '', row.direction || '',
                    row.time_start || '', row.time_end || '',
                    row.non_motor_count || '', row.reverse_count || '', row.red_light_count || '',
                    row.stop_line_count || '', row.no_crosswalk_count || '', row.other_count || '',
                    row.total || '', row.compliance_rate || '',
                    row.right_turn_count || '', row.no_yield_count || '', row.yield_rate || '',
                    row.illegal_count || '', username, row.remark || '',
                    row.non_motor_total || '', row.wrong_lane_count || '', row.compliance_rate_non || '',
                    row.parking_violation || '', row.jaywalk_count || '',
                    row.crosswalk_total || '', row.no_yield_cross || '', row.compliance_rate_cross || '',
                    imageUrlsJson,
                    todayStr
                ]);
                assessmentId = result.lastID;
            }

            // 写入图片明细表（先删旧记录，再插新记录）
            await dbRun('DELETE FROM assessment_images WHERE assessment_id = ?', [assessmentId]);
            for (const u of urls) {
                if (!u) continue;
                // 存相对路径
                const rel = String(u).replace(/^https?:\/\/[^/]+/, '');
                await dbRun(
                    `INSERT INTO assessment_images
                     (assessment_id, resource_name, evaluator, assessment_date, image_type, image_url)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [assessmentId, row.name, username, todayStr, imageType || '', rel]
                );
            }

            successCount++;
        }

        logOperation(username, '提交测评', `成功 ${successCount} 行，失败 ${errorCount} 行`, ip);
        res.json({
            success: true,
            message: `提交完成: 成功 ${successCount} 行, 失败 ${errorCount} 行`,
            successCount,
            errorCount
        });
    } catch (e) {
        console.error('提交失败:', e);
        res.status(500).json({ error: e.message });
    }
});
// ============ 管理员汇总 ============
app.get('/api/admin/all-assessments', requireAuth, (req, res) => {
    if (req.session.user.role !== 'admin') {
        return res.status(403).json({ error: '需要管理员权限' });
    }

    const { startDate, endDate, drawDate } = req.query;
    let sql = `
        SELECT 
            a.*,
            r.type_label as resource_type_label
        FROM assessments a
        LEFT JOIN resources r ON a.name = r.name
        WHERE 1=1
    `;
    let params = [];

    if (startDate && endDate) {
        sql += ` AND a.assessment_date BETWEEN ? AND ?`;
        params.push(startDate, endDate);
    }

    if (drawDate) {
        sql += ` AND a.assessment_date = ?`;
        params.push(drawDate);
    }

    sql += ` ORDER BY a.assessment_date DESC, a.type DESC, a.row_index`;

    db.all(sql, params, (err, rows) => {
        if (err) {
            console.error('查询汇总数据失败:', err);
            return res.status(500).json({ error: err.message });
        }
        rows.forEach(r => {
            try { r.image_urls = JSON.parse(r.image_urls || '[]'); }
            catch (e) { r.image_urls = []; }
        });
        res.json(rows);
    });
});

// ============ 导出测评数据（JSON，供前端生成 XLSX） ============
app.get('/api/admin/export-assessments', requireAuth, (req, res) => {
    if (req.session.user.role !== 'admin') {
        return res.status(403).json({ error: '需要管理员权限' });
    }

    const { startDate, endDate, drawDate } = req.query;
    let sql = `
        SELECT 
            a.*,
            r.type_label as resource_type_label
        FROM assessments a
        LEFT JOIN resources r ON a.name = r.name
        WHERE 1=1
    `;
    let params = [];

    if (startDate && endDate) {
        sql += ` AND a.assessment_date BETWEEN ? AND ?`;
        params.push(startDate, endDate);
    }

    if (drawDate) {
        sql += ` AND a.assessment_date = ?`;
        params.push(drawDate);
    }

    sql += ` ORDER BY a.assessment_date DESC, a.type DESC, a.row_index`;

    db.all(sql, params, (err, rows) => {
        if (err) {
            console.error('导出数据失败:', err);
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// ============ 导出抽取记录（JSON） ============
app.get('/api/admin/export-draw-records', requireAuth, (req, res) => {
    if (req.session.user.role !== 'admin') {
        return res.status(403).json({ error: '需要管理员权限' });
    }

    const { weekKey, drawDate } = req.query;
    let sql = `
        SELECT dr.*, r.id as resource_id, r.name, r.type, r.type_label, r.area, r.camera
        FROM draw_records dr
        JOIN resources r ON dr.resource_id = r.id
        WHERE 1=1
    `;
    let params = [];

    if (weekKey) {
        sql += ` AND dr.week_key = ?`;
        params.push(weekKey);
    }
    if (drawDate) {
        sql += ` AND dr.draw_date = ?`;
        params.push(drawDate);
    }
    sql += ` ORDER BY dr.draw_date ASC, r.type DESC`;

    db.all(sql, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// ============ 按天导出：数据 + 图片打包 zip ============
app.get('/api/admin/export-with-images', requireAuth, (req, res) => {
    if (req.session.user.role !== 'admin') {
        return res.status(403).json({ error: '需要管理员权限' });
    }
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: '请提供日期 date=YYYY-MM-DD' });

    db.all('SELECT * FROM assessments WHERE assessment_date = ? ORDER BY type DESC, row_index',
        [date], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });

            db.all('SELECT * FROM assessment_images WHERE assessment_date = ?',
                [date], (err2, imgs) => {
                    if (err2) return res.status(500).json({ error: err2.message });

                    res.setHeader('Content-Type', 'application/zip');
                    res.setHeader('Content-Disposition', `attachment; filename="export_${date}.zip"`);

                    const archive = archiver('zip', { zlib: { level: 9 } });
                    archive.on('error', e => {
                        console.error('打包失败:', e);
                        try { res.status(500).end(); } catch (_) {}
                    });
                    archive.pipe(res);

                    // 1. 数据 XLSX
                    const dataForSheet = rows.map(r => {
                        let urls = [];
                        try { urls = JSON.parse(r.image_urls || '[]'); } catch (_) {}
                        return {
                            '类型': r.type === 'cross' ? '路口' : '路段',
                            '班次': r.paixu || '',
                            '测评点位': r.name || '',
                            '摄像头位置': r.camera || '',
                            '路口方向': r.direction || '',
                            '开始时间': r.time_start || '',
                            '结束时间': r.time_end || '',
                            '非机动车行人数': r.non_motor_count || '',
                            '逆行': r.reverse_count || '',
                            '闯红灯': r.red_light_count || '',
                            '越线停车': r.stop_line_count || '',
                            '行人不走斑马线': r.no_crosswalk_count || '',
                            '其他': r.other_count || '',
                            '合计': r.total || '',
                            '非机动车行人遵章率': r.compliance_rate || '',
                            '右转弯机动车数量': r.right_turn_count || '',
                            '未礼让数量': r.no_yield_count || '',
                            '礼让率': r.yield_rate || '',
                            '路口违法车辆数': r.illegal_count || '',
                            '测评人': r.evaluator || '',
                            '测评日期': r.assessment_date || '',
                            '备注': r.remark || '',
                            '图片文件': urls.map(u => String(u).split('/').pop()).join(' | ')
                        };
                    });
                    const ws = XLSX.utils.json_to_sheet(dataForSheet);
                    const wb = XLSX.utils.book_new();
                    XLSX.utils.book_append_sheet(wb, ws, '测评数据');
                    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
                    archive.append(buf, { name: `测评数据_${date}.xlsx` });

                    // 2. 图片
                    imgs.forEach(img => {
                        const rel = String(img.image_url || '').replace(/^\//, '');
                        const filePath = path.join(__dirname, 'public', rel);
                        if (fs.existsSync(filePath)) {
                            archive.file(filePath, { name: `图片/${path.basename(filePath)}` });
                        }
                    });

                    archive.finalize();
                });
        });
});

// ============ 操作日志 ============
app.get('/api/logs', requireAuth, (req, res) => {
    if (req.session.user.role !== 'admin') {
        return res.status(403).json({ error: '需要管理员权限' });
    }
    const limit = parseInt(req.query.limit) || 200;
    db.all(
        'SELECT * FROM operation_logs ORDER BY created_at DESC LIMIT ?',
        [limit],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        }
    );
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============ 图片上传 ============
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '_' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname) || '.jpg';
        cb(null, uniqueSuffix + ext);
    }
});

const fileFilter = (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
        cb(null, true);
    } else {
        cb(new Error('只允许上传图片文件'), false);
    }
};

const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: fileFilter
});

// 图片上传接口：按规则重命名
app.post('/api/upload-image', requireAuth, upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: '请选择图片' });

    const { resourceName = '', date = '', dataType = '' } = req.body;
    const safe = s => String(s).replace(/[\\/:*?"<>|\s]/g, '_');
    const ext = path.extname(req.file.filename) || '.jpg';
    const newName = `${safe(req.session.user.username)}_${safe(date)}_${safe(resourceName)}_${safe(dataType)}不达标${ext}`;
    const newPath = path.join(uploadDir, newName);

    try {
        if (fs.existsSync(newPath)) {
            // 避免重名覆盖：加时间戳
            const alt = `${safe(req.session.user.username)}_${safe(date)}_${safe(resourceName)}_${safe(dataType)}不达标_${Date.now()}${ext}`;
            fs.renameSync(req.file.path, path.join(uploadDir, alt));
            return res.json({ success: true, url: '/uploads/' + alt, filename: alt });
        }
        fs.renameSync(req.file.path, newPath);
        res.json({ success: true, url: '/uploads/' + newName, filename: newName });
    } catch (e) {
        console.error('重命名失败:', e);
        res.json({ success: true, url: '/uploads/' + req.file.filename, filename: req.file.filename });
    }
});

// 提供静态文件访问（uploads目录）
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

// ============ 启动服务器 ============
app.listen(PORT, () => {
    console.log(`🚀 服务器运行在端口 ${PORT}`);
    console.log(`📊 访问地址: http://localhost:${PORT}`);
});

module.exports = app;
