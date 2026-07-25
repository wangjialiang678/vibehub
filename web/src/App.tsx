import { Navigate, Route, Routes } from 'react-router-dom';
import { AdminPage } from './pages/AdminPage';
import { AdminInvitesPage } from './pages/AdminInvitesPage';
import { AdminOverviewPage } from './pages/AdminOverviewPage';
import { AdminProjectsPage } from './pages/AdminProjectsPage';
import { CollectionPage } from './pages/CollectionPage';
import { LoginPage } from './pages/LoginPage';
import { StudentPage } from './pages/StudentPage';
import { StudentVersionsPage } from './pages/StudentVersionsPage';

export function App() {
  return <Routes><Route path="/app" element={<StudentPage />} /><Route path="/app/versions" element={<StudentVersionsPage />} /><Route path="/admin" element={<AdminPage />} /><Route path="/admin/overview" element={<AdminOverviewPage />} /><Route path="/admin/invites" element={<AdminInvitesPage />} /><Route path="/admin/projects" element={<AdminProjectsPage />} /><Route path="/admin/projects/:projectId" element={<AdminProjectsPage />} /><Route path="/c/:campSlug" element={<CollectionPage />} /><Route path="/login" element={<LoginPage />} /><Route path="*" element={<Navigate to="/app" replace />} /></Routes>;
}
