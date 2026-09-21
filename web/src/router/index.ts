import { createRouter, createWebHashHistory } from 'vue-router'
import { auth } from '@/stores/auth'

const Login = () => import('@/views/LoginView.vue')
const MainLayout = () => import('@/layouts/MainLayout.vue')
const Dashboard = () => import('@/views/DashboardView.vue')
const Models = () => import('@/views/ModelsView.vue')
const Keys = () => import('@/views/KeysView.vue')

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
