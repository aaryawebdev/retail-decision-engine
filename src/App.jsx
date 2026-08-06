import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import { ActingUserProvider } from './context/ActingUserContext';
import ActingUserPicker from './components/ActingUserPicker';
import InvestmentDirectEntry from './pages/InvestmentDirectEntry';
import InvestmentBulkUpload from './pages/InvestmentBulkUpload';
import ReturnDirectEntry from './pages/ReturnDirectEntry';
import IntegrationConfig from './pages/IntegrationConfig';
import TargetSetting from './pages/TargetSetting';
import Leadership from './pages/Leadership';
import Operating from './pages/Operating';
import Diagnostic from './pages/Diagnostic';
import './App.css';

const NAV_GROUPS = [
  {
    label: 'Data Entry',
    links: [
      { to: '/investment/entry', label: 'Investment — Direct Entry' },
      { to: '/investment/upload', label: 'Investment — Bulk Upload' },
      { to: '/return/entry', label: 'Return — Direct Entry' },
      { to: '/integrations', label: 'Integrations' },
      { to: '/targets', label: 'Targets' },
    ],
  },
  {
    label: 'Decision Support',
    links: [
      { to: '/leadership', label: 'Leadership' },
      { to: '/operating', label: 'Operating' },
      { to: '/diagnostic', label: 'Diagnostic' },
    ],
  },
];

function TopNav() {
  return (
    <header className="top-nav">
      <nav>
        {NAV_GROUPS.map((group, i) => (
          <div className="nav-group" key={group.label}>
            {i > 0 && <span className="nav-divider" aria-hidden="true" />}
            <span className="nav-group-label">{group.label}</span>
            {group.links.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
              >
                {link.label}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <ActingUserPicker />
    </header>
  );
}

export default function App() {
  return (
    <ActingUserProvider>
      <BrowserRouter>
        <TopNav />
        <main>
          <Routes>
            <Route path="/investment/entry" element={<InvestmentDirectEntry />} />
            <Route path="/investment/upload" element={<InvestmentBulkUpload />} />
            <Route path="/return/entry" element={<ReturnDirectEntry />} />
            <Route path="/integrations" element={<IntegrationConfig />} />
            <Route path="/targets" element={<TargetSetting />} />
            <Route path="/leadership" element={<Leadership />} />
            <Route path="/operating" element={<Operating />} />
            <Route path="/diagnostic" element={<Diagnostic />} />
            <Route path="*" element={<InvestmentDirectEntry />} />
          </Routes>
        </main>
      </BrowserRouter>
    </ActingUserProvider>
  );
}
