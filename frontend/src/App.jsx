import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import ProtectedRoute from './components/ProtectedRoute';
import Landing from './pages/Landing';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import NewMigration from './pages/NewMigration';
import MigrationStatus from './pages/MigrationStatus';
import ValidationReport from './pages/ValidationReport';
import ConnectedOrgs from './pages/ConnectedOrgs';
import Reports from './pages/Reports';
import Settings from './pages/Settings';
import Generator from './pages/Generator';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public */}
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<Login />} />

        {/* Protected */}
        <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
        <Route path="/orgs" element={<ProtectedRoute><ConnectedOrgs /></ProtectedRoute>} />
        <Route path="/generator" element={<ProtectedRoute><Generator /></ProtectedRoute>} />
        <Route path="/reports" element={<ProtectedRoute><Reports /></ProtectedRoute>} />
        <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
        <Route path="/migrations/new" element={<ProtectedRoute><NewMigration /></ProtectedRoute>} />
        <Route path="/migrations/:id" element={<ProtectedRoute><MigrationStatus /></ProtectedRoute>} />
        <Route path="/migrations/:id/report" element={<ProtectedRoute><ValidationReport /></ProtectedRoute>} />

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
