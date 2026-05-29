import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Link, Outlet, useParams, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { ChakraProvider, Box, Divider, Flex, Heading, Text, VStack } from '@chakra-ui/react';
import { LayoutDashboard, FolderKanban, Calculator, Settings as SettingsIcon } from 'lucide-react';
import theme from './theme';
import StepIndicator from './components/StepIndicator';
import GlobalPipelineProgress from './components/GlobalPipelineProgress';
import SettingsDrawer from './components/SettingsDrawer';
import { ErrorBoundary } from './components/ErrorBoundary';
import useAppStore from './store/useAppStore';
import { getStageStatuses } from './utils/pipelineStatus';
import api from './api';

import Dashboard from './pages/Dashboard';
import Projects from './pages/Projects';
import Calculators from './pages/Calculators';
import VisionAnalysis from './pages/VisionAnalysis';
import Reports from './pages/Reports';
import Settings from './pages/Settings';
import ProjectWizard from './pages/ProjectWizard';
import ProjectDetail from './pages/ProjectDetail';
import Analysis from './pages/Analysis';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60,
      retry: 1,
    },
  },
});

const SIDEBAR_W = '224px';

// ---------------------------------------------------------------------------
// Sidebar nav item — link variant (router navigation)
// ---------------------------------------------------------------------------
function NavItem({ to, label, active, icon: Icon }: { to: string; label: string; active: boolean; icon: React.ElementType }) {
  return (
    <Box
      as={Link}
      to={to}
      display="flex"
      alignItems="center"
      gap={3}
      px={5}
      py={2.5}
      fontSize="sm"
      fontWeight={active ? '600' : '400'}
      color={active ? 'brand.700' : 'gray.600'}
      bg={active ? 'brand.50' : 'transparent'}
      borderRight="3px solid"
      borderColor={active ? 'brand.500' : 'transparent'}
      _hover={{ bg: active ? 'brand.50' : 'gray.100', color: 'gray.800' }}
      textDecoration="none"
      transition="all 0.2s ease"
    >
      <Icon size={18} />
      {label}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Sidebar nav item — button variant (in-page action; e.g. open drawer)
// ---------------------------------------------------------------------------
function NavButton({ label, active, icon: Icon, onClick }: { label: string; active: boolean; icon: React.ElementType; onClick: () => void }) {
  return (
    <Box
      as="button"
      type="button"
      onClick={onClick}
      display="flex"
      alignItems="center"
      gap={3}
      px={5}
      py={2.5}
      fontSize="sm"
      fontWeight={active ? '600' : '400'}
      color={active ? 'brand.700' : 'gray.600'}
      bg={active ? 'brand.50' : 'transparent'}
      borderRight="3px solid"
      borderColor={active ? 'brand.500' : 'transparent'}
      _hover={{ bg: active ? 'brand.50' : 'gray.100', color: 'gray.800' }}
      textAlign="left"
      w="full"
      transition="all 0.2s ease"
      cursor="pointer"
    >
      <Icon size={18} />
      {label}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------
function Sidebar({ onOpenSettings, settingsActive }: { onOpenSettings: () => void; settingsActive: boolean }) {
  const { pathname } = useLocation();

  const mainItems = [
    { label: 'Dashboard', to: '/', active: pathname === '/', icon: LayoutDashboard },
    { label: 'Projects', to: '/projects', active: pathname.startsWith('/projects'), icon: FolderKanban },
    { label: 'Calculators', to: '/calculators', active: pathname.startsWith('/calculators'), icon: Calculator },
  ];

  return (
    <Flex
      direction="column"
      w={SIDEBAR_W}
      minW={SIDEBAR_W}
      h="100vh"
      position="fixed"
      top={0}
      left={0}
      bg="white"
      borderRight="1px solid"
      borderColor="gray.200"
      zIndex={10}
    >
      {/* Logo */}
      <Box px={5} py={5}>
        <Heading
          as={Link}
          to="/"
          size="md"
          color="brand.600"
          textDecoration="none"
          _hover={{ color: 'brand.700' }}
        >
          SceneRx
        </Heading>
        <Text fontSize="2xs" color="gray.400" mt={0.5} letterSpacing="wide">
          Urban Greenspace Platform
        </Text>
      </Box>

      <Divider />

      {/* Main section */}
      <VStack spacing={0} align="stretch" flex={1} pt={4}>
        <Text
          px={5}
          mb={2}
          fontSize="2xs"
          fontWeight="700"
          color="gray.400"
          textTransform="uppercase"
          letterSpacing="widest"
        >
          Main
        </Text>
        {mainItems.map((item) => (
          <NavItem key={item.to} {...item} />
        ))}
      </VStack>

      {/* Bottom — Settings opens an in-page drawer instead of navigating
          away, so the user keeps their place. The /settings route still
          works as a deep-link fallback. */}
      <Divider />
      <Box py={3}>
        <NavButton
          label="Settings"
          active={settingsActive}
          icon={SettingsIcon}
          onClick={onOpenSettings}
        />
      </Box>
    </Flex>
  );
}

// ---------------------------------------------------------------------------
// Pipeline layout — wraps project pipeline pages with StepIndicator
// ---------------------------------------------------------------------------
function ProjectPipelineLayout() {
  const { projectId } = useParams<{ projectId: string }>();
  const { pathname } = useLocation();
  const {
    recommendations,
    zoneAnalysisResult,
    aiReport,
    setCurrentProject,
    hydrateFromProject,
  } = useAppStore();

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.projects.get(projectId!).then(res => res.data),
    enabled: !!projectId,
  });

  // Keep the Zustand store in sync with React Query and hydrate Stage 1 /
  // analysis artefacts from the backend (source of truth for everything
  // project-scoped). hydrateFromProject overwrites unconditionally, so a
  // fresh tab opening project A cannot leak the previous session's blobs
  // — and switching from A to B atomically swaps in B's data with no
  // intermediate "cleared" state for the UI to flash.
  //
  // Order matters: hydrateFromProject inspects state.currentProject?.id to
  // detect "same project refetch vs. project switch" so it can preserve
  // session-only state (pipelineResult, cluster snapshot) on refetches.
  // We hydrate FIRST while currentProject still holds the previous value,
  // then update currentProject. Reversing this order makes sameProject
  // always evaluate true.
  useEffect(() => {
    if (!project) return;
    hydrateFromProject(project);
    setCurrentProject(project);
  }, [project, setCurrentProject, hydrateFromProject]);

  const segment = pathname.split('/').pop() || '';
  // 5-step: Project(1) → Images(2) → Prepare(3) → Analysis(4) → Report(5)
  const stepMap: Record<string, number> = { edit: 1, vision: 3, analysis: 4, reports: 5 };
  const currentStep = stepMap[segment] || 2; // fallback 2 = Images

  const stageStatuses = getStageStatuses(project ?? null, {
    recommendations,
    zoneAnalysisResult,
    aiReport,
  });

  return (
    <>
      <StepIndicator currentStep={currentStep} projectId={projectId || ''} stageStatuses={stageStatuses} />
      <Outlet />
    </>
  );
}

/** Layout for /projects/new — shows StepIndicator at step 1 with no project loaded */
function NewProjectLayout() {
  const stageStatuses = getStageStatuses(null, { recommendations: [], zoneAnalysisResult: null, aiReport: null });

  return (
    <>
      <StepIndicator currentStep={1} projectId="" stageStatuses={stageStatuses} />
      <Outlet />
    </>
  );
}

// ---------------------------------------------------------------------------
// AppShell — owns the in-page Settings drawer state. Lives inside the Router
// so it can read the current pathname for the active-state highlight on the
// Settings nav item (the deep-link /settings route still highlights it).
// ---------------------------------------------------------------------------
function AppShell() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { pathname } = useLocation();
  const settingsActive = settingsOpen || pathname.startsWith('/settings');

  return (
    <Flex minH="100vh">
      <Sidebar
        onOpenSettings={() => setSettingsOpen(true)}
        settingsActive={settingsActive}
      />

      {/* Main content area */}
      <Box ml={SIDEBAR_W} flex={1} minH="100vh" minW={0} overflow="hidden">
        <GlobalPipelineProgress />
        {/* v4.x — Top-level ErrorBoundary catches ANY unhandled render
            crash in ANY route. Without this, a button click that triggers
            a state mutation followed by a render crash (e.g. an
            undefined-property access in a deeply-nested chart component,
            a dismiss button revealing a previously-hidden subtree that
            then throws, a panorama view switch racing with hydration)
            takes the whole app to a white screen. The boundary keeps the
            sidebar and header intact and shows a recoverable inline alert
            in the content area, plus "Try to recover" and "Reload page"
            buttons. Inner boundaries (e.g. the chart-grid boundary in
            Reports.tsx) still catch first; this one is the last line of
            defense.

            Keyed on pathname so navigating away from a crashed route
            (sidebar link, browser back, etc.) auto-resets the boundary
            instead of stubbornly keeping the error alert when the user
            has already moved on. */}
        <ErrorBoundary
          label="this page"
          key={`route-${pathname}`}
        >
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/projects" element={<Projects />} />

            {/* New project — step 1 of pipeline */}
            <Route path="/projects/new" element={<NewProjectLayout />}>
              <Route index element={<ProjectWizard />} />
            </Route>

            {/* 5-step pipeline: Project → Images → Prepare → Analysis → Report */}
            <Route path="/projects/:projectId" element={<ProjectPipelineLayout />}>
              <Route index element={<ProjectDetail />} />
              <Route path="edit" element={<ProjectWizard />} />
              <Route path="vision" element={<VisionAnalysis />} />
              <Route path="analysis" element={<Analysis />} />
              <Route path="reports" element={<Reports />} />
            </Route>

            <Route path="/calculators" element={<Calculators />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </ErrorBoundary>
      </Box>

      <SettingsDrawer
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </Flex>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ChakraProvider theme={theme}>
        <BrowserRouter>
          <AppShell />
        </BrowserRouter>
      </ChakraProvider>
    </QueryClientProvider>
  );
}

export default App;
