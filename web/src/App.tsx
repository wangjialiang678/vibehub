import { Navigate, Route, Routes } from 'react-router-dom';
import { AdminPage } from './pages/AdminPage';
import { CollectionPage } from './pages/CollectionPage';
import { LoginPage } from './pages/LoginPage';
import { StudentPage } from './pages/StudentPage';

export function App() {
  return <Routes><Route path="/app" element={<StudentPage />} /><Route path="/admin" element={<AdminPage />} /><Route path="/c/:campSlug" element={<CollectionPage />} /><Route path="/login" element={<LoginPage />} /><Route path="*" element={<Navigate to="/app" replace />} /></Routes>;
}
