# 城市地下综合管廊运行维护管理平台

面向管廊主体台账、入廊管线登记、廊内环境监测、通风排水消防、结构沉降与渗漏处置、巡检检修与隐患整改、入廊作业审批和运维值班的一体化城市地下综合管廊运行维护管理工作台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 管廊主体台账 | `tunnel` | 综合管廊 | 管廊编号、管廊名称、所属片区 |
| 入廊管线登记 | `pipeline` | 入廊管线 | 管线编号、所属舱室、管线类型 |
| 廊内环境监测 | `envmonitor` | 环境监测记录 | 监测编号、监测点位、环境温度 |
| 通风系统运维 | `ventilation` | 通风机组 | 机组编号、所属舱室、风机型号 |
| 廊内排水运维 | `drainage` | 排水泵坑 | 泵坑编号、所属舱室、集水坑容积 |
| 消防系统运维 | `firecontrol` | 消防设施 | 设施编号、所属舱室、消防类型 |
| 廊内照明运维 | `lighting` | 照明灯具 | 灯具编号、所属舱室、灯具类型 |
| 门禁安防运维 | `access` | 安防点位 | 点位编号、所属出入口、门禁类型 |
| 廊内巡检任务 | `patrol` | 巡检任务 | 巡检编号、巡检路线、巡检班组 |
| 结构沉降监测 | `settlement` | 沉降监测点 | 监测编号、监测断面、累计沉降量 |
| 渗漏水处置 | `leak` | 渗漏处置单 | 处置编号、渗漏点位、渗漏程度 |
| 设施检修管理 | `maintenance` | 检修记录 | 检修编号、检修对象、检修类别 |
| 隐患整改管理 | `hazard` | 隐患记录 | 隐患编号、隐患部位、隐患等级 |
| 应急演练管理 | `emergency` | 应急演练 | 演练编号、演练场景、参与班组 |
| 廊内能耗计量 | `energy` | 能耗计量记录 | 计量编号、计量点位、用电量 |
| 设备台账管理 | `device` | 管廊设备 | 设备编号、设备名称、设备型号 |
| 入廊作业审批 | `entryapprove` | 作业申请 | 申请编号、申请单位、作业舱室 |
| 运维值班交接 | `duty` | 值班交接记录 | 交接编号、值班班组、值班日期 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 渗漏程度、处置方式与返工判定只有一份实现：`frontend/src/domain/leak-disposal.ts`，
  列表、动作、另存、详情与值班台账共用；口径与取舍见 `docs/leak-disposal.md`。
- 所有写库统一走 `frontend/src/data/local-store.ts` 的 `commit`/`transact`：先迁移补齐、
  再整体校验、最后一次性落库，任何一步失败整笔退回。
- 想回到初始数据：清掉浏览器里 `urban-utility-tunnel:entries` 这一项，或调用 `resetModule(模块)`。
