import axios from 'axios'

const client = axios.create({
  baseURL: '/api/admin',
  timeout: 30000,
  withCredentials: true,
})

client.interceptors.response.use(
  (res) => res,
  (err) => {
    const status = err.response?.status
    if (status === 401 && !window.location.hash.startsWith('#/login')) {
      window.location.hash = '#/login'
    }
    return Promise.reject(err)
  },
)

export default client
