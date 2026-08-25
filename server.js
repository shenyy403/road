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
    d.setUTCHours(0, 0, 0, 0);
    const year = d.getFullYear();
    const jan1 = new Date(year, 0, 1);
    const days = Math.floor((d - jan1) / 86400000);
    const week = Math.ceil((days + jan1.getDay() + 1) / 7);
    return `${year}-W${String(week).padStart(2, '0')}`;
}

function getDayOfWeek(date = new Date()) {
    const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return days[date.getDay()];
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
    db.all('SELECT * FROM resources ORDER BY id', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/resources/import', requireAuth, (req, res) => {
    if (req.session.user.role !== 'admin') {
        return res.status(403).json({ error: '需要管理员权限' });
    }
    const { resources } = req.body;
    if (!resources || !Array.isArray(resources) || resources.length === 0) {
        return res.status(400).json({ error: '请提供资源列表' });
    }
    db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        db.run('DELETE FROM resources');
        const stmt = db.prepare('INSERT INTO resources (id, name, type, type_label, responsible, area) VALUES (?, ?, ?, ?, ?, ?)');
        resources.forEach(r => {
            stmt.run(r.id, r.name, r.type, r.type_label, r.responsible, r.area || '');
        });
        stmt.finalize();
        db.run('COMMIT');
    });
    logOperation(req.session.user.username, '导入资源', `导入了 ${resources.length} 个资源`, getClientIp(req));
    res.json({ success: true, count: resources.length });
});

// ============ 抽取相关 ============
// 获取某周所有抽取记录（按日期分组）
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
            
            // 按日期分组
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

// 获取当前用户今日抽取的资源（用于自动填入测评表格）
app.get('/api/my-today-draw', requireAuth, (req, res) => {
    const username = req.session.user.username;
    const todayStr = new Date().toISOString().slice(0, 10);
    const weekKey = getWeekKey();

    db.all(
        `SELECT dr.resource_id, r.name, r.type, r.type_label, r.responsible, r.camera,
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

// 抽取
app.post('/api/draw', requireAuth, (req, res) => {
    const { weekKey, roadCount, crossCount } = req.body;
    const todayStr = new Date().toISOString().slice(0, 10);
    const username = req.session.user.username;
    const ip = getClientIp(req);

    if (!weekKey) {
        return res.status(400).json({ error: '缺少必要参数' });
    }

    // 先检查今天是否已经抽取过
    db.get(
        'SELECT COUNT(*) as count FROM draw_records WHERE week_key = ? AND draw_date = ?',
        [weekKey, todayStr],
        (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (row.count > 0) {
                return res.json({ 
                    success: false, 
                    message: '⚠️ 今天已经抽取过了，请勿重复抽取！' 
                });
            }

            const targetRoadCount = roadCount || 8;
            const targetCrossCount = crossCount || 7;

            db.all('SELECT resource_id FROM draw_records WHERE week_key = ?', [weekKey], (err, drawnRows) => {
                if (err) return res.status(500).json({ error: err.message });
                const drawnIds = new Set(drawnRows.map(r => r.resource_id));

                db.all('SELECT * FROM resources WHERE type = ?', ['road'], (err, allRoads) => {
                    if (err) return res.status(500).json({ error: err.message });
                    db.all('SELECT * FROM resources WHERE type = ?', ['cross'], (err, allCrosses) => {
                        if (err) return res.status(500).json({ error: err.message });

                        const availableRoads = allRoads.filter(r => !drawnIds.has(r.id));
                        const availableCrosses = allCrosses.filter(r => !drawnIds.has(r.id));

                        const shuffledRoads = availableRoads.sort(() => Math.random() - 0.5);
                        const shuffledCrosses = availableCrosses.sort(() => Math.random() - 0.5);

                        const roadDrawCount = Math.min(targetRoadCount, shuffledRoads.length);
                        const crossDrawCount = Math.min(targetCrossCount, shuffledCrosses.length);

                        const selectedRoads = shuffledRoads.slice(0, roadDrawCount);
                        const selectedCrosses = shuffledCrosses.slice(0, crossDrawCount);
                        const selected = [...selectedRoads, ...selectedCrosses];

                        if (selected.length === 0) {
                            logOperation(username, '抽取失败', '本周资源已全部抽完', ip);
                            return res.json({ success: false, message: '本周所有资源已抽完！' });
                        }

                        db.serialize(() => {
                            db.run('BEGIN TRANSACTION');
                            const stmt = db.prepare('INSERT INTO draw_records (resource_id, draw_date, week_key) VALUES (?, ?, ?)');
                            selected.forEach(item => {
                                stmt.run(item.id, todayStr, weekKey);
                            });
                            stmt.finalize();
                            db.run('COMMIT', (err) => {
                                if (err) {
                                    db.run('ROLLBACK');
                                    return res.status(500).json({ error: '提交失败' });
                                }
                                const details = `路段 ${selectedRoads.length} 个, 路口 ${selectedCrosses.length} 个`;
                                logOperation(username, '抽取资源', details, ip);
                                res.json({
                                    success: true,
                                    selected: selected,
                                    roadCount: selectedRoads.length,
                                    crossCount: selectedCrosses.length,
                                    totalRemaining: availableRoads.length + availableCrosses.length - selected.length,
                                    message: `✅ 成功抽取 ${selectedRoads.length} 个路段 + ${selectedCrosses.length} 个路口`
                                });
                            });
                        });
                    });
                });
            });
        }
    );
});

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
    const todayStr = new Date().toISOString().slice(0, 10);

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
    const todayStr = new Date().toISOString().slice(0, 10);
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

    const { startDate, endDate } = req.query;
    let sql = `
        SELECT 
            a.*,
            r.type_label as resource_type_label
        FROM assessments a
        LEFT JOIN resources r ON a.name = r.name
        ORDER BY a.assessment_date DESC, a.type DESC, a.row_index
    `;
    let params = [];

    if (startDate && endDate) {
        sql = `
            SELECT 
                a.*,
                r.type_label as resource_type_label
            FROM assessments a
            LEFT JOIN resources r ON a.name = r.name
            WHERE a.assessment_date BETWEEN ? AND ?
            ORDER BY a.assessment_date DESC, a.type DESC, a.row_index
        `;
        params = [startDate, endDate];
    }

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

    const { startDate, endDate } = req.query;
    let sql = `
        SELECT 
            a.*,
            r.type_label as resource_type_label
        FROM assessments a
        LEFT JOIN resources r ON a.name = r.name
        ORDER BY a.assessment_date DESC, a.type DESC, a.row_index
    `;
    let params = [];

    if (startDate && endDate) {
        sql = `
            SELECT 
                a.*,
                r.type_label as resource_type_label
            FROM assessments a
            LEFT JOIN resources r ON a.name = r.name
            WHERE a.assessment_date BETWEEN ? AND ?
            ORDER BY a.assessment_date DESC, a.type DESC, a.row_index
        `;
        params = [startDate, endDate];
    }

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
