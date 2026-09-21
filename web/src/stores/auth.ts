import { reactive } from 'vue'
import client from '@/api/client'

export interface User {
  username: string
  role: string
}

export const auth = reactive({
  user: null as User | null,
  async load() {
    try {
      const { data } = await client.get('/auth/me')
      this.user = data
    } catch {
      this.user = null
    }
    return this.user
  },
  async login(username: string, password: string) {
    const { data } = await client.post('/auth/login', { username, password })
    this.user = { username: data.username, role: data.role }
    return this.user
  },
  async logout() {
    await client.post('/auth/logout')
    this.user = null
  },
})
