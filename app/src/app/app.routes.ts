import type { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./pages/library/library.page').then((m) => m.LibraryPage),
  },
  {
    path: 'book/:id',
    loadComponent: () => import('./pages/book/book.page').then((m) => m.BookPage),
  },
  {
    path: 'settings',
    loadComponent: () => import('./pages/settings/settings.page').then((m) => m.SettingsPage),
  },
  { path: '**', redirectTo: '' },
];
