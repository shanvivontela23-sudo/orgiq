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
import History from './pages/History';
import ComingSoon from './pages/ComingSoon';
import UsersPage from './pages/Users';
import ObjectsPage from './pages/Objects';
import PermissionsPage from './pages/Permissions';
import MappingSheet from './pages/MappingSheet';
import DaikanDemo from './pages/DaikanDemo';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public */}
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<Login />} />

        {/* Protected — existing */}
        <Route path="/dashboard"            element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
        <Route path="/orgs"                 element={<ProtectedRoute><ConnectedOrgs /></ProtectedRoute>} />
        <Route path="/generator"            element={<ProtectedRoute><Generator /></ProtectedRoute>} />
        <Route path="/reports"              element={<ProtectedRoute><Reports /></ProtectedRoute>} />
        <Route path="/settings"             element={<ProtectedRoute><Settings /></ProtectedRoute>} />
        <Route path="/migrations/new"       element={<ProtectedRoute><NewMigration /></ProtectedRoute>} />
        <Route path="/migrations/:id"       element={<ProtectedRoute><MigrationStatus /></ProtectedRoute>} />
        <Route path="/migrations/:id/report" element={<ProtectedRoute><ValidationReport /></ProtectedRoute>} />
        <Route path="/history"              element={<ProtectedRoute><History /></ProtectedRoute>} />

        {/* Protected — new (placeholders until built) */}
        <Route path="/mapping-sheet" element={<ProtectedRoute><MappingSheet /></ProtectedRoute>} />
        <Route path="/users" element={<ProtectedRoute><UsersPage /></ProtectedRoute>} />
        <Route path="/objects" element={<ProtectedRoute><ObjectsPage /></ProtectedRoute>} />
        <Route path="/permissions" element={<ProtectedRoute><PermissionsPage /></ProtectedRoute>} />

        {/* Client demos */}
        <Route path="/demos/daikan" element={<ProtectedRoute><DaikanDemo /></ProtectedRoute>} />

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
