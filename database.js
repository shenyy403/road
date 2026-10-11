const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
}

const dbPath = path.join(dataDir, 'draw.db');
const db = new sqlite3.Database(dbPath);

db.run('PRAGMA foreign_keys = ON');

db.serialize(() => {
  // ===== 用户表 =====
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS operation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT,
      ip TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // ===== 资源表（无责任人） =====
  db.run(`
    CREATE TABLE IF NOT EXISTS resources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      type_label TEXT NOT NULL,
      responsible TEXT,
      area TEXT,
      camera TEXT,
      plan_key TEXT NOT NULL
    )
  `);

  // ===== 抽取记录表 =====
  db.run(`
    CREATE TABLE IF NOT EXISTS draw_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      resource_id TEXT NOT NULL,
      draw_date TEXT NOT NULL,
      week_key TEXT NOT NULL,
      assigned_to TEXT,
      FOREIGN KEY (resource_id) REFERENCES resources(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS assessments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('cross', 'road')),
      row_index INTEGER NOT NULL,
      paixu TEXT,
      name TEXT,
      camera TEXT,
      direction TEXT,
      time_start TEXT,
      time_end TEXT,
      non_motor_count TEXT,
      reverse_count TEXT,
      red_light_count TEXT,
      stop_line_count TEXT,
      no_crosswalk_count TEXT,
      other_count TEXT,
      total TEXT,
      compliance_rate TEXT,
      right_turn_count TEXT,
      no_yield_count TEXT,
      yield_rate TEXT,
      illegal_count TEXT,
      evaluator TEXT NOT NULL,
      remark TEXT,
      non_motor_total TEXT,
      wrong_lane_count TEXT,
      compliance_rate_non TEXT,
      parking_violation TEXT,
      jaywalk_count TEXT,
      crosswalk_total TEXT,
      no_yield_cross TEXT,
      compliance_rate_cross TEXT,
      assessment_date TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS resource_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_key TEXT UNIQUE NOT NULL,
      plan_name TEXT NOT NULL,
      is_active INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      week_key TEXT NOT NULL,
      is_participating INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(username, week_key)
    )
  `);

  // ===== 轮次配置表（管理员选日期） =====
  db.run(`
    CREATE TABLE IF NOT EXISTS draw_rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_key TEXT UNIQUE NOT NULL,
      plan_key TEXT NOT NULL,
      dates TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // ===== 测评图片表 =====
  db.run(`
    CREATE TABLE IF NOT EXISTS assessment_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assessment_id INTEGER,
      resource_name TEXT,
      evaluator TEXT NOT NULL,
      assessment_date TEXT NOT NULL,
      image_type TEXT,
      image_url TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // ===== 自定义方案表（管理员勾选资源） =====
  db.run(`
    CREATE TABLE IF NOT EXISTS custom_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_name TEXT NOT NULL,
      resource_ids TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // ===== 给 assessments 加 image_urls 字段（安全 ALTER） =====
  db.all("PRAGMA table_info(assessments)", (err, cols) => {
    if (err) return console.error(err);
    const hasImageUrls = cols.some(c => c.name === 'image_urls');
    if (!hasImageUrls) {
      db.run("ALTER TABLE assessments ADD COLUMN image_urls TEXT DEFAULT '[]'", (e) => {
        if (e) console.error('加 image_urls 失败:', e);
        else console.log('✅ assessments 已添加 image_urls 字段');
      });
    }
  });

  // ===== 创建用户 =====
  const allUsers = [
    { username: '石晓婷', password: '199639', role: 'admin' },
    { username: '白书语', password: 'Ywxtly0428', role: 'admin' },
    { username: '韩江', password: '123456', role: 'user' },
    { username: '关鑫', password: '123456', role: 'user' },
    { username: '王鑫', password: '123456', role: 'user' },
    { username: '王鼎群', password: '123456', role: 'user' },
    { username: '付彧', password: '123456', role: 'user' },
    { username: '田丰', password: '123456', role: 'user' },
    { username: '刘添睿', password: '123456', role: 'user' },
    { username: '刘嘉伦', password: '123456', role: 'user' },
    { username: '关丽丽', password: '123456', role: 'user' },
    { username: '孙昱', password: '123456', role: 'user' },
    { username: '毕世伟', password: '123456', role: 'user' },
    { username: '李松', password: '123456', role: 'user' },
    { username: '肖阳', password: '123456', role: 'user' },
    { username: '李佳', password: '123456', role: 'user' },
    { username: '杨子晴', password: '123456', role: 'user' },
    { username: '佟璘', password: '123456', role: 'user' },
    { username: '张健', password: '123456', role: 'user' },
    { username: '吴达', password: '123456', role: 'user' },
    { username: '金晓宇', password: '123456', role: 'user' },
    { username: '赵一雯', password: '123456', role: 'user' },
    { username: '徐嘉璐', password: '123456', role: 'user' },
    { username: '郭翔宇', password: '123456', role: 'user' },
    { username: '姬鹏', password: '123456', role: 'user' },
    { username: '文雷', password: '123456', role: 'user' },
    { username: '才多', password: '123456', role: 'user' }
  ];

  allUsers.forEach(user => {
    db.get('SELECT * FROM users WHERE username = ?', [user.username], (err, row) => {
      if (err) return console.error(err);
      if (!row) {
        db.run('INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
          [user.username, user.password, user.role]);
        console.log(`✅ 用户已创建: ${user.username}`);
      }
    });
  });

  // ===== 初始化资源方案 =====
  db.run('INSERT OR IGNORE INTO resource_plans (plan_key, plan_name, is_active) VALUES (?, ?, ?)',
    ['plan_a', '方案A（70个资源）', 1]);
  db.run('INSERT OR IGNORE INTO resource_plans (plan_key, plan_name, is_active) VALUES (?, ?, ?)',
    ['plan_b', '方案B（42个资源：8路段 + 34路口）', 0]);

  // ===== 初始化资源 =====
  db.get('SELECT COUNT(*) as count FROM resources', (err, row) => {
    if (err) return console.error(err);
    if (row.count === 0) {
      console.log('📦 初始化资源数据...');
      initDefaultResources();
    }
  });
});

// ============================================================
// 资源数据（所有资源 responsible 为空）
// ============================================================
function initDefaultResources() {
  const allResources = [];

  // ============================================================
  // 路口数据 (C1~C34)
  // ============================================================
  const crossData = [
    { id: 'C1', name: '锦兴路成都街151', camera: '锦兴路成都街', area: '高新区' },
    { id: 'C2', name: '成都街与锦兴路交叉口卡口—YD2', camera: '锦兴路成都街', area: '高新区' },
    { id: 'C3', name: '解放路士英街102', camera: '解放路士英街', area: '古塔区' },
    { id: 'C4', name: '解放路士英街东侧', camera: '解放路士英街', area: '古塔区' },
    { id: 'C5', name: '市府路云飞南街南0010', camera: '市府路云飞南街', area: '高新区' },
    { id: 'C6', name: '云飞南街-市府路北侧西-五期', camera: '市府路云飞南街', area: '高新区' },
    { id: 'C7', name: '市府路中央南街东242', camera: '市府路中央南街', area: '高新区' },
    { id: 'C8', name: '中央南街市府路南251', camera: '市府路中央南街', area: '高新区' },
    { id: 'C9', name: '解放路-锦华街-五期', camera: '解放路锦华街', area: '古塔区' },
    { id: 'C10', name: '锦华街-解放路东侧—YD4', camera: '解放路锦华街', area: '古塔区' },
    { id: 'C11', name: '中央大街南京路东341', camera: '南京路中央大街', area: '凌河区' },
    { id: 'C12', name: '中央大街南京路交叉口（凌安）-YD1', camera: '南京路中央大街', area: '凌河区' },
    { id: 'C13', name: '科技路中央南街南侧', camera: '科技路中央南街', area: '高新区' },
    { id: 'C14', name: '科技路中央南街西侧', camera: '科技路中央南街', area: '高新区' },
    { id: 'C15', name: '中央大街与洛阳路交叉口东—YD2', camera: '洛阳路中央大街', area: '凌河区' },
    { id: 'C16', name: '中央大街洛阳路西侧', camera: '洛阳路中央大街', area: '凌河区' },
    { id: 'C17', name: '延安路云飞街185', camera: '延安路云飞街', area: '凌河区' },
    { id: 'C18', name: '延安路-云飞街-一期', camera: '延安路云飞街', area: '凌河区' },
    { id: 'C19', name: '金厦酒店-门前-五期', camera: '解放路人民街', area: '古塔区' },
    { id: 'C20', name: '解放路人民街北292', camera: '解放路人民街', area: '古塔区' },
    { id: 'C21', name: '中央街解放路0052', camera: '解放路中央大街', area: '凌河区' },
    { id: 'C22', name: '解放路中央大街东侧', camera: '解放路中央大街', area: '凌河区' },
    { id: 'C23', name: '上海路徐州街99', camera: '上海路徐州街', area: '凌河区' },
    { id: 'C24', name: '上海路徐州街路口—YD4', camera: '上海路徐州街', area: '凌河区' },
    { id: 'C25', name: '中央大街上海路46', camera: '上海路中央大街', area: '凌河区' },
    { id: 'C26', name: '上海路与中央大街交叉口东-二期', camera: '上海路中央大街', area: '凌河区' },
    { id: 'C27', name: '解放路徐州街384', camera: '解放路徐州街', area: '凌河区' },
    { id: 'C28', name: '矿山机器厂-门前-一期', camera: '解放路徐州街', area: '凌河区' },
    { id: 'C29', name: '延安路人民街16', camera: '延安路人民街', area: '古塔区' },
    { id: 'C30', name: '延安路人民街西侧', camera: '延安路人民街', area: '古塔区' },
    { id: 'C31', name: '云飞街洛阳路37', camera: '洛阳路云飞街', area: '凌河区' },
    { id: 'C32', name: '洛阳路-云飞街-一期', camera: '洛阳路云飞街', area: '凌河区' },
    { id: 'C33', name: '解放路云飞南街东侧', camera: '解放路云飞街', area: '凌河区' },
    { id: 'C34', name: '解放路云飞南街北侧', camera: '解放路云飞街', area: '凌河区' }
  ];

  // 方案A路口
  crossData.forEach((d) => {
    allResources.push({
      id: d.id,
      name: d.name,
      type: 'cross',
      type_label: '路口',
      responsible: '',
      area: d.area,
      camera: d.camera,
      plan_key: 'plan_a'
    });
  });

  // 方案B路口
  crossData.forEach((d) => {
    allResources.push({
      id: d.id + '_b',
      name: d.name,
      type: 'cross',
      type_label: '路口',
      responsible: '',
      area: d.area,
      camera: d.camera,
      plan_key: 'plan_b'
    });
  });

  // ============================================================
  // 方案A - 36个路段
  // ============================================================
  const roadDataA = [
    { id: 'R1', name: '凌川路', camera: '凌川桥桥南头142', area: '松山区' },
    { id: 'R2', name: '成都街', camera: '锦兴路-成都街-五期', area: '松山区' },
    { id: 'R3', name: '松坡路', camera: '松坡路3段-24号楼-四期', area: '凌河区' },
    { id: 'R4', name: '松坡路', camera: '松坡路-东北五金城-一期', area: '凌河区' },
    { id: 'R5', name: '士英南街', camera: '胜昔路士英南街176', area: '古塔区' },
    { id: 'R6', name: '士英南街', camera: '南街所门前路边往南照—YD2', area: '古塔区' },
    { id: 'R7', name: '凌西大街', camera: '凌西大街南郡天下313', area: '太和区' },
    { id: 'R8', name: '凌西大街', camera: '凌西大街太平街00204', area: '太和区' },
    { id: 'R9', name: '中央大街', camera: '和平路中央街239', area: '凌河区' },
    { id: 'R10', name: '中央大街', camera: '中央街洛阳路00333', area: '凌河区' },
    { id: 'R11', name: '中环西路', camera: '绕城公路金峰轮胎厂路口00710', area: '太和区' },
    { id: 'R12', name: '中环西路', camera: '绕城公路西宁街00709', area: '太和区' },
    { id: 'R13', name: '爱民街', camera: '重庆路爱民街348', area: '凌河区' },
    { id: 'R14', name: '爱民街', camera: '辽沈战役纪念馆外墙东北角—YD4', area: '凌河区' },
    { id: 'R15', name: '士英街', camera: '士英街北京路东南357', area: '古塔区' },
    { id: 'R16', name: '士英街', camera: '士英街宜昌路至金缘路路段54', area: '古塔区' },
    { id: 'R17', name: '中央南街', camera: '渤海大道南山隧道00265', area: '松山区' },
    { id: 'R18', name: '中央南街', camera: '南山隧道北00566', area: '松山区' },
    { id: 'R19', name: '市府路', camera: '市府路长沙街00359', area: '松山区' },
    { id: 'R20', name: '市府路', camera: '市府路云飞南街西侧', area: '松山区' },
    { id: 'R21', name: '解放路', camera: '解放路汉口街00138', area: '古塔区' },
    { id: 'R22', name: '解放路', camera: '西桥西侧引桥00225', area: '古塔区' },
    { id: 'R23', name: '科技路', camera: '科技路云飞街西00420', area: '松山区' },
    { id: 'R24', name: '科技路', camera: '科技路吉祥街247', area: '松山区' },
    { id: 'R25', name: '人民街', camera: '北湖公园西门387', area: '古塔区' },
    { id: 'R26', name: '人民街', camera: '农经校门前-四期', area: '古塔区' },
    { id: 'R27', name: '北京路', camera: '北京路吴淞街167', area: '凌河区' },
    { id: 'R28', name: '北京路', camera: '北京路汉口街183', area: '古塔区' },
    { id: 'R29', name: '凌川路', camera: '联通公司北门-七期', area: '松山区' },
    { id: 'R30', name: '凌川路', camera: '兴隆北侧税务局东南角—YD4', area: '松山区' },
    { id: 'R31', name: '昆明街', camera: '东方庭院-东门-五期', area: '松山区' },
    { id: 'R32', name: '昆明街', camera: '市府路-昆明街-六期', area: '松山区' },
    { id: 'R33', name: '山西街', camera: '南宁路山西街173', area: '古塔区' },
    { id: 'R34', name: '山西街', camera: '解放路-山西街西南角—YD4', area: '古塔区' },
    { id: 'R35', name: '重庆路', camera: '实华园小区-北门-四期', area: '古塔区' },
    { id: 'R36', name: '重庆路', camera: '重庆路新制街369', area: '凌河区' }
  ];

  roadDataA.forEach((d) => {
    allResources.push({
      id: d.id,
      name: d.name,
      type: 'road',
      type_label: '路段',
      responsible: '',
      area: d.area,
      camera: d.camera,
      plan_key: 'plan_a'
    });
  });

  // ============================================================
  // 方案B - 8个路段
  // ============================================================
  const roadDataB = [
    { id: 'R2_b', name: '典逸新洲东门斑马线', camera: '锦兴路-成都街-五期', area: '松山区' },
    { id: 'R8_b', name: '太平街路口南100米斑马线', camera: '凌西大街太平街00204', area: '太和区' },
    { id: 'R10_b', name: '洛阳路南侧200米斑马线', camera: '中央街洛阳路00333', area: '凌河区' },
    { id: 'R16_b', name: '回民小学门前斑马线', camera: '士英街金缘路0054', area: '古塔区' },
    { id: 'R21_b', name: '石油公司门前斑马线', camera: '解放路汉口街00138', area: '古塔区' },
    { id: 'R23_b', name: '天鹅堡门前西侧100米斑马线', camera: '科技路云飞街西00420', area: '松山区' },
    { id: 'R33_b', name: '锦绣前程南宁路路口北100米斑马线', camera: '南宁路山西街173', area: '古塔区' },
    { id: 'R36_b', name: '新制街路口东200米斑马线', camera: '重庆路新制街369', area: '凌河区' }
  ];

  roadDataB.forEach((d) => {
    allResources.push({
      id: d.id,
      name: d.name,
      type: 'road',
      type_label: '路段',
      responsible: '',
      area: d.area,
      camera: d.camera,
      plan_key: 'plan_b'
    });
  });

  // ============================================================
  // 批量插入
  // ============================================================
  const stmt = db.prepare(
    'INSERT INTO resources (id, name, type, type_label, responsible, area, camera, plan_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );

  allResources.forEach(r => {
    stmt.run(r.id, r.name, r.type, r.type_label, r.responsible, r.area, r.camera, r.plan_key);
  });

  stmt.finalize();

  console.log(`✅ 资源初始化完成（无责任人）:`);
  console.log(`   - 方案A: 70个资源 (36路段 + 34路口)`);
  console.log(`   - 方案B: 42个资源 (8路段 + 34路口)`);
  console.log(`   - 总计: ${allResources.length} 条记录`);
}

module.exports = db;
