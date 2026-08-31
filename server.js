const express = require('express');
const cors = require('cors');
const session = require('express-session');
const db = require('./database');
const path = require('path');

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

// ============ 抽取记录 ============
app.get('/api/records/:weekKey', requireAuth, (req, res) => {
    const { weekKey } = req.params;
    db.all(
        `SELECT r.*, dr.draw_date, dr.week_key 
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
                dr.draw_date
         FROM draw_records dr
         JOIN resources r ON dr.resource_id = r.id
         WHERE dr.week_key = ?
           AND r.responsible = ?
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

    const { participants } = req.body;
    const weekKey = getWeekKey();
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
    const weekKey = getWeekKey();
    
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

// ============ 均衡抽取整周 ============
app.post('/api/draw-week', requireAuth, (req, res) => {
    const { weekKey, planKey } = req.body;
    const username = req.session.user.username;
    const ip = getClientIp(req);

    if (!weekKey) {
        return res.status(400).json({ error: '缺少必要参数' });
    }

    const dates = getWeekDatesFromToday();
    
    db.get('SELECT COUNT(*) as count FROM draw_records WHERE week_key = ?', [weekKey], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (row.count > 0) {
            return res.json({
                success: false,
                message: '⚠️ 本周已有抽取记录，请先重置再重新抽取！'
            });
        }

        // 获取参与用户
        db.all('SELECT username, is_participating FROM user_participants WHERE week_key = ?', [weekKey], (err, participantRows) => {
            if (err) return res.status(500).json({ error: err.message });
            
            let activeUsers;
            if (participantRows.length > 0) {
                activeUsers = participantRows.filter(r => r.is_participating === 1).map(r => r.username);
            } else {
                db.all("SELECT username FROM users WHERE role = 'user'", (err2, allUsers) => {
                    if (err2) return res.status(500).json({ error: err2.message });
                    activeUsers = allUsers.map(r => r.username);
                    doDraw(activeUsers);
                });
                return;
            }
            doDraw(activeUsers);
        });
    });

    function doDraw(activeUsers) {
        // 获取当前激活方案
        db.get('SELECT plan_key FROM resource_plans WHERE is_active = 1', (err, planRow) => {
            if (err) return res.status(500).json({ error: err.message });
            const currentPlan = planRow ? planRow.plan_key : 'plan_a';
            
            // 获取该方案下的资源
            db.all('SELECT * FROM resources WHERE plan_key = ?', [currentPlan], (err, allResources) => {
                if (err) return res.status(500).json({ error: err.message });

                // 只取参与用户对应的资源
                const userResources = allResources.filter(r => activeUsers.includes(r.responsible));
                
                const roads = userResources.filter(r => r.type === 'road');
                const crosses = userResources.filter(r => r.type === 'cross');
                
                // 随机打乱
                const shuffledRoads = roads.sort(() => Math.random() - 0.5);
                const shuffledCrosses = crosses.sort(() => Math.random() - 0.5);

                const userCount = activeUsers.length;
                const totalCrosses = shuffledCrosses.length;
                const totalRoads = shuffledRoads.length;
                
                // 工作量：路口=1.0，路段=0.5
                const totalWork = totalCrosses * 1.0 + totalRoads * 0.5;
                const avgWork = totalWork / userCount;
                
                // 每个用户分配结果
                const userAssignments = activeUsers.map(user => ({
                    username: user,
                    crossCount: 0,
                    roadCount: 0,
                    totalWork: 0,
                    crosses: [],
                    roads: []
                }));
                
                // 分配路口
                let crossIndex = 0;
                while (crossIndex < shuffledCrosses.length) {
                    for (let u = 0; u < userAssignments.length && crossIndex < shuffledCrosses.length; u++) {
                        if (userAssignments[u].totalWork >= avgWork + 0.5) continue;
                        userAssignments[u].crosses.push(shuffledCrosses[crossIndex]);
                        userAssignments[u].crossCount++;
                        userAssignments[u].totalWork += 1.0;
                        crossIndex++;
                    }
                    if (crossIndex > 0 && userAssignments.every(u => u.totalWork >= avgWork)) break;
                }
                
                // 分配路段
                let roadIndex = 0;
                while (roadIndex < shuffledRoads.length) {
                    for (let u = 0; u < userAssignments.length && roadIndex < shuffledRoads.length; u++) {
                        if (userAssignments[u].totalWork >= avgWork + 0.5) continue;
                        userAssignments[u].roads.push(shuffledRoads[roadIndex]);
                        userAssignments[u].roadCount++;
                        userAssignments[u].totalWork += 0.5;
                        roadIndex++;
                    }
                    if (roadIndex > 0 && userAssignments.every(u => u.totalWork >= avgWork)) break;
                }
                
                // 剩余资源分配给工作量最少的人
                const remainingCrosses = shuffledCrosses.slice(crossIndex);
                const remainingRoads = shuffledRoads.slice(roadIndex);
                
                remainingCrosses.forEach(cross => {
                    userAssignments.sort((a, b) => a.totalWork - b.totalWork);
                    userAssignments[0].crosses.push(cross);
                    userAssignments[0].crossCount++;
                    userAssignments[0].totalWork += 1.0;
                });
                
                remainingRoads.forEach(road => {
                    userAssignments.sort((a, b) => a.totalWork - b.totalWork);
                    userAssignments[0].roads.push(road);
                    userAssignments[0].roadCount++;
                    userAssignments[0].totalWork += 0.5;
                });
                
                // 生成抽取记录
                const allRecords = [];
                const dailyStats = [];
                
                dates.forEach((date, dayIndex) => {
                    const dayRecords = [];
                    
                    userAssignments.forEach(assignment => {
                        assignment.crosses.forEach((cross, idx) => {
                            if (idx % 5 === dayIndex) {
                                dayRecords.push({ 
                                    resource_id: cross.id, 
                                    draw_date: date, 
                                    week_key: weekKey 
                                });
                            }
                        });
                        assignment.roads.forEach((road, idx) => {
                            if (idx % 5 === dayIndex) {
                                dayRecords.push({ 
                                    resource_id: road.id, 
                                    draw_date: date, 
                                    week_key: weekKey 
                                });
                            }
                        });
                    });
                    
                    allRecords.push(...dayRecords);
                    
                    const dayRoads = dayRecords.filter(r => {
                        const res = allResources.find(res => res.id === r.resource_id);
                        return res && res.type === 'road';
                    });
                    const dayCrosses = dayRecords.filter(r => {
                        const res = allResources.find(res => res.id === r.resource_id);
                        return res && res.type === 'cross';
                    });
                    
                    dailyStats.push({
                        date: date,
                        dayOfWeek: getDayOfWeek(date),
                        roadCount: dayRoads.length,
                        crossCount: dayCrosses.length,
                        total: dayRecords.length
                    });
                });
                
                if (allRecords.length === 0) {
                    return res.json({ success: false, message: '⚠️ 没有可用的资源！' });
                }

                db.serialize(() => {
                    db.run('BEGIN TRANSACTION');
                    const stmt = db.prepare('INSERT INTO draw_records (resource_id, draw_date, week_key) VALUES (?, ?, ?)');
                    
                    allRecords.forEach(record => {
                        stmt.run(record.resource_id, record.draw_date, record.week_key);
                    });
                    
                    stmt.finalize();
                    db.run('COMMIT', (err) => {
                        if (err) {
                            db.run('ROLLBACK');
                            return res.status(500).json({ error: '提交失败' });
                        }

                        const totalCount = allRecords.length;
                        logOperation(username, '批量抽取整周', 
                            `共${totalCount}条记录，${userCount}人参与，方案: ${currentPlan}`, 
                            ip
                        );
                        
                        const workReport = userAssignments.map(a => 
                            `${a.username}: 路口${a.crossCount}个(权重1) + 路段${a.roadCount}个(权重0.5) = ${a.totalWork.toFixed(1)}`
                        ).join(' | ');

                        const detailMsg = dailyStats.map(d => 
                            d.date + '(' + d.dayOfWeek + '): ' + d.total + '个'
                        ).join('\n');

                        res.json({
                            success: true,
                            message: `✅ 成功抽取整周！共 ${totalCount} 个点位\n\n📊 工作量分配：\n${workReport}`,
                            total: totalCount,
                            days: dates.length,
                            dailyStats: dailyStats,
                            userWorkload: userAssignments.map(a => ({
                                username: a.username,
                                crossCount: a.crossCount,
                                roadCount: a.roadCount,
                                totalWork: a.totalWork
                            })),
                            planKey: currentPlan
                        });
                    });
                });
            });
        });
    }
});

// ============ 重置本周 ============
app.delete('/api/reset/:weekKey', requireAuth, (req, res) => {
    const { weekKey } = req.params;
    const username = req.session.user.username;
    const ip = getClientIp(req);
    db.run('DELETE FROM draw_records WHERE week_key = ?', [weekKey], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        logOperation(username, '重置本周', `删除 ${this.changes} 条抽取记录`, ip);
        res.json({ success: true, deleted: this.changes });
    });
});

// ============ 测评数据相关 ============
app.get('/api/my-assessments-today', requireAuth, (req, res) => {
    const username = req.session.user.username;
    const todayStr = getTodayChina();

    db.all(
        `SELECT * FROM assessments
         WHERE evaluator = ?
           AND assessment_date = ?
         ORDER BY type DESC, row_index`,
        [username, todayStr],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        }
    );
});

app.post('/api/assessments/submit', requireAuth, (req, res) => {
    const username = req.session.user.username;
    const todayStr = getTodayChina();
    const { assessments } = req.body;

    if (!assessments || !Array.isArray(assessments) || assessments.length === 0) {
        return res.status(400).json({ error: '请提供测评数据' });
    }

    let successCount = 0;
    let errorCount = 0;
    const ip = getClientIp(req);

    db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        assessments.forEach((row) => {
            if (!row.name || row.name.trim() === '') {
                return;
            }

            if (row.evaluator !== username) {
                errorCount++;
                return;
            }

            db.get(
                `SELECT id FROM assessments 
                 WHERE name = ? AND evaluator = ? AND assessment_date = ? AND type = ? AND row_index = ?`,
                [row.name, username, todayStr, row.type, row.row_index || 0],
                (err, existing) => {
                    if (err) { errorCount++; return; }

                    const sql = existing ? `
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
                            updated_at = datetime('now')
                        WHERE id = ?
                    ` : `
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
                            assessment_date
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `;

                    const params = existing ? [
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
                        existing.id
                    ] : [
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
                        todayStr
                    ];

                    db.run(sql, params, function(err) {
                        if (err) {
                            console.error('提交失败:', err);
                            errorCount++;
                            return;
                        }
                        successCount++;
                    });
                }
            );
        });

        db.run('COMMIT', (err) => {
            if (err) {
                db.run('ROLLBACK');
                console.error('提交事务失败:', err);
                return res.status(500).json({ error: '提交失败' });
            }
            logOperation(username, '提交测评', `成功 ${successCount} 行，失败 ${errorCount} 行`, ip);
            res.json({
                success: true,
                message: `提交完成: 成功 ${successCount} 行, 失败 ${errorCount} 行`,
                successCount,
                errorCount
            });
        });
    });
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
        res.json(rows);
    });
});

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

// ============ 启动服务器 ============
app.listen(PORT, () => {
    console.log(`🚀 服务器运行在端口 ${PORT}`);
    console.log(`📊 访问地址: http://localhost:${PORT}`);
});

module.exports = app;
