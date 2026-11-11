import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { ElLoading, ElMessage, ElMessageBox } from 'element-plus'
import 'element-plus/es/components/loading/style/css'
import 'element-plus/es/components/message/style/css'
import 'element-plus/es/components/message-box/style/css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import { Download, Upload, Plus, VideoPause, VideoPlay, RefreshRight, FolderOpened, Delete, Folder, Close, CircleCheckFilled, Setting, Sunny, Moon, Document, VideoCamera, Link } from '@element-plus/icons-vue'
const ElementPlusIconsVue = { Download, Upload, Plus, VideoPause, VideoPlay, RefreshRight, FolderOpened, Delete, Folder, Close, CircleCheckFilled, Setting, Sunny, Moon, Document, VideoCamera, Link }
import App from './App.vue'
import i18n from './i18n'
import './styles.css'

const app = createApp(App)
app.use(createPinia())
app.use(i18n)
app.use(ElLoading)
app.use(ElMessage)
app.use(ElMessageBox)
for (const [name, comp] of Object.entries(ElementPlusIconsVue)) {
  app.component(name, comp)
}
app.mount('#app')
