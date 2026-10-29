import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router.ts';
import './styles.css';

const app = createApp(App).use(router);
// index.html shows a loading state until the first route (and the session check) is ready.
void router.isReady().then(() => app.mount('#app'));
