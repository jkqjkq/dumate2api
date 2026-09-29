import { createRouter, createWebHashHistory } from 'vue-router'
import { auth } from '@/stores/auth'

const Login = () => import('@/views/LoginView.vue')
const MainLayout = () => import('@/layouts/MainLayout.vue')
const Dashboard = () => import('@/views/DashboardView.vue')
const Models = () => import('@/views/ModelsView.vue')
const Keys = () => import('@/views/KeysView.vue')
const Account = () => import('@/views/AccountView.vue')
const Points = () => import('@/views/PointsView.vue')
const WebAccounts = () => import('@/views/WebAccountsView.vue')
const Usage = () => import('@/views/UsageView.vue')
const ReqLogs = () => import('@/views/ReqLogsView.vue')
const ChatLab = () => import('@/views/ChatLabView.vue')

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/login', component: Login, meta: { public: true } },
    {
      path: '/',
      component: MainLayout,
      children: [
        { path: '', component: Dashboard, meta: { title: '仪表盘', key: 'dashboard' } },
        { path: 'models', component: Models, meta: { title: '模型管理', key: 'models' } },
        { path: 'keys', component: Keys, meta: { title: 'API Key', key: 'keys' } },
        { path: 'account', component: Account, meta: { title: '登录态', key: 'account' } },
        { path: 'points', component: Points, meta: { title: '积分明细', key: 'points' } },
        { path: 'web-accounts', component: WebAccounts, meta: { title: '账号管理', key: 'web-accounts' } },
        { path: 'usage', component: Usage, meta: { title: '用量统计', key: 'usage' } },
        { path: 'reqlogs', component: ReqLogs, meta: { title: '请求日志', key: 'reqlogs' } },
        { path: 'chatlab', component: ChatLab, meta: { title: '聊天测试台', key: 'chatlab' } },
      ],
    },
  ],
})

router.beforeEach(async (to) => {
  if (to.meta.public) return true
  if (!auth.user) await auth.load()
  if (!auth.user) return { path: '/login' }
  return true
})

export default router
