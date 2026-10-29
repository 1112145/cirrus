import { createRouter, createWebHistory } from 'vue-router';
import { whenAuthLost } from './api.ts';
import AppLayout from './components/AppLayout.vue';
import { notify } from './stores/notify.ts';
import { loadSchema, schema } from './stores/schema.ts';
import { forget, restore, session } from './stores/session.ts';
import LoginView from './views/LoginView.vue';

declare module 'vue-router' {
  interface RouteMeta {
    /** Open to visitors who aren't logged in. */
    public?: boolean;
    /** For admins only. */
    admin?: boolean;
  }
}

export const router = createRouter({
  // Served by the Worker's static assets under /admin/ (spec §13).
  history: createWebHistory('/admin/'),
  routes: [
    { path: '/login', name: 'login', component: LoginView, meta: { public: true } },
    {
      path: '/',
      component: AppLayout,
      children: [
        { path: '', redirect: '/content' },
        { path: 'content', name: 'content', component: () => import('./views/ContentHome.vue') },
        { path: 'content/:collection', name: 'collection', component: () => import('./views/CollectionView.vue') },
        { path: 'content/:collection/:id', name: 'item', component: () => import('./views/ItemView.vue') },
        { path: 'files', name: 'files', component: () => import('./views/FilesView.vue') },
        { path: 'files/:id', name: 'file', component: () => import('./views/FileView.vue') },
        { path: 'users', name: 'users', component: () => import('./views/UsersView.vue') },
        { path: 'users/:id', name: 'user', component: () => import('./views/UserView.vue') },
        { path: 'settings', redirect: '/settings/data-model' },
        { path: 'settings/data-model', name: 'data-model', component: () => import('./views/DataModelView.vue'), meta: { admin: true } },
        {
          path: 'settings/data-model/:collection',
          name: 'collection-settings',
          component: () => import('./views/CollectionSettingsView.vue'),
          meta: { admin: true },
        },
        { path: 'settings/roles', name: 'roles', component: () => import('./views/RolesView.vue'), meta: { admin: true } },
        { path: 'settings/roles/:id', name: 'role', component: () => import('./views/RoleView.vue'), meta: { admin: true } },
        { path: 'settings/policies', name: 'policies', component: () => import('./views/PoliciesView.vue'), meta: { admin: true } },
        { path: 'settings/policies/:id', name: 'policy', component: () => import('./views/PolicyView.vue'), meta: { admin: true } },
        { path: ':pathMatch(.*)*', name: 'not-found', component: () => import('./views/NotFoundView.vue') },
      ],
    },
  ],
});

router.beforeEach(async (to) => {
  if (!session.checked) await restore();
  if (to.meta.public) return session.user ? '/content' : true;
  if (!session.user) return { name: 'login', query: to.fullPath === '/' || to.fullPath === '/content' ? {} : { redirect: to.fullPath } };
  if (!schema.loaded) await loadSchema();
  if (to.meta.admin && !session.admin) return '/content';
  return true;
});

// A request found the session gone: back to the login, then here again.
whenAuthLost(() => {
  if (!session.user) return;
  forget();
  notify('Your session ended. Please sign in again.', 'info');
  void router.push({ name: 'login', query: { redirect: router.currentRoute.value.fullPath } });
});
