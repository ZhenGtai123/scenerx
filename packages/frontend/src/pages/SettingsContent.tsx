import { useState, useEffect, useCallback } from 'react';
import {
  Box,
  Heading,
  Button,
  VStack,
  HStack,
  FormControl,
  FormLabel,
  SimpleGrid,
  Card,
  CardHeader,
  CardBody,
  Text,
  Badge,
  Divider,
  Select,
  Input,
  Code,
  Skeleton,
} from '@chakra-ui/react';
import { Server, Eye, Brain, Database, Cpu } from 'lucide-react';
import { useConfig, useHealth, useKnowledgeBaseSummary, useLLMProviders, useProviderModels, useVisionHealth, queryKeys } from '../hooks/useApi';
import { useQueryClient } from '@tanstack/react-query';
import api from '../api';
import type { LLMProviderInfo } from '../types';
import useAppToast from '../hooks/useAppToast';

// Fallback model lists (used when dynamic fetch is unavailable, e.g. no API key
// or upstream call failed). The dynamic /api/config/models/{provider} endpoint
// is the authoritative source whenever a key is configured.
const FALLBACK_MODELS: Record<string, { id: string; label: string }[]> = {
  gemini: [
    { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  ],
  openai: [
    { id: 'gpt-4o', label: 'GPT-4o (default)' },
    { id: 'gpt-4o-mini', label: 'GPT-4o Mini (cheaper)' },
    { id: 'gpt-4.1', label: 'GPT-4.1 (latest)' },
    { id: 'gpt-4.1-mini', label: 'GPT-4.1 Mini (fast)' },
    { id: 'gpt-4.1-nano', label: 'GPT-4.1 Nano (cheapest)' },
  ],
  anthropic: [
    { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4 (default)' },
    { id: 'claude-opus-4-20250514', label: 'Claude Opus 4 (strongest)' },
    { id: 'claude-haiku-4-20250514', label: 'Claude Haiku 4 (fast)' },
  ],
  deepseek: [
    { id: 'deepseek-chat', label: 'DeepSeek Chat (default)' },
    { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner (R1)' },
  ],
};

interface SettingsContentProps {
  /** Hide the outer Loading skeleton (used when content is in a Drawer that has its own loading state). */
  embedded?: boolean;
}

/**
 * Body of the Settings page — the SimpleGrid of cards, with no PageShell/PageHeader.
 * Used both by the standalone /settings route (via Settings.tsx) and the
 * SettingsDrawer overlay opened from the sidebar.
 */
export function SettingsContent({ embedded = false }: SettingsContentProps) {
  const { data: config, isLoading: configLoading } = useConfig();
  const { data: health } = useHealth();
  const { data: kbSummary } = useKnowledgeBaseSummary();
  const { data: llmProviders, isLoading: providersLoading } = useLLMProviders();
  const queryClient = useQueryClient();
  const toast = useAppToast();

  const activeProviderId = llmProviders?.find((p: LLMProviderInfo) => p.active)?.id;
  const { data: dynamicModels, isLoading: modelsLoading } = useProviderModels(activeProviderId);

  // Vision health is cached via React Query (2-min staleTime) so the
  // SettingsDrawer toggling doesn't re-ping the Vision API. The Test
  // button below invalidates the cache on demand.
  const { data: visionData, isFetching: testingVision, refetch: refetchVisionHealth } = useVisionHealth();
  const visionHealthy = visionData ? visionData.healthy : null;
  const visionInfo = visionData?.info ?? null;
  const [llmStatus, setLlmStatus] = useState<{ configured: boolean; provider: string; model: string | null } | null>(null);
  const [testingLLM, setTestingLLM] = useState(false);
  const [switchingProvider, setSwitchingProvider] = useState(false);
  const [customModel, setCustomModel] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  // Vision API URL editor — pre-fills from /api/config and persists via
  // PUT /api/config/vision-url (writes .env + resets vision client singleton).
  const [visionUrlInput, setVisionUrlInput] = useState('');
  const [savingVisionUrl, setSavingVisionUrl] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Hydrate input from async server config; the input then becomes user-editable state, so a derived useMemo would not let the user override.
    if (config?.vision_api_url) setVisionUrlInput(config.vision_api_url);
  }, [config?.vision_api_url]);

  const activeProvider = llmProviders?.find((p: LLMProviderInfo) => p.active);

  useEffect(() => {
    if (activeProvider?.current_model) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Hydrate model picker from server's currently active provider; user edits the field afterward.
      setCustomModel(activeProvider.current_model);
    }
  }, [activeProvider?.current_model]);

  const testVisionConnection = useCallback(async () => {
    try {
      const result = await refetchVisionHealth();
      const healthy = result.data?.healthy ?? false;
      toast({
        title: healthy ? 'Vision API connected' : 'Vision API not available',
        status: healthy ? 'success' : 'warning',
      });
    } catch {
      toast({ title: 'Failed to connect to Vision API', status: 'error' });
    }
  }, [refetchVisionHealth, toast]);

  const testLLMConnection = async () => {
    setTestingLLM(true);
    try {
      const response = await api.testLLM();
      setLlmStatus(response.data);
      toast({
        title: response.data.configured
          ? `${response.data.provider} connected`
          : 'LLM not configured',
        status: response.data.configured ? 'success' : 'warning',
      });
    } catch {
      setLlmStatus(null);
      toast({ title: 'Failed to test LLM connection', status: 'error' });
    }
    setTestingLLM(false);
  };

  const handleSwitchProvider = async (providerId: string, model?: string) => {
    setSwitchingProvider(true);
    try {
      const response = await api.switchLLMProvider(providerId, model || undefined);
      toast({
        title: `Switched to ${response.data.provider}`,
        description: `Model: ${response.data.model}`,
        status: 'success',
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.llmProviders });
      queryClient.invalidateQueries({ queryKey: queryKeys.config });
      setLlmStatus(null);
    } catch (error: unknown) {
      const detail =
        (error as { response?: { data?: { detail?: string } } })?.response?.data?.detail
        || 'Failed to switch provider';
      toast({ title: detail, status: 'error' });
    }
    setSwitchingProvider(false);
  };

  const handleUpdateApiKey = async () => {
    if (!activeProvider || !apiKeyInput.trim()) return;
    setSavingKey(true);
    try {
      await api.updateLLMApiKey(activeProvider.id, apiKeyInput.trim());
      toast({ title: `API key updated for ${activeProvider.name}`, status: 'success' });
      setApiKeyInput('');
      queryClient.invalidateQueries({ queryKey: queryKeys.llmProviders });
      // Re-fetch the dynamic model list now that the key is saved.
      queryClient.invalidateQueries({ queryKey: queryKeys.providerModels(activeProvider.id) });
      setLlmStatus(null);
    } catch (error: unknown) {
      const detail =
        (error as { response?: { data?: { detail?: string } } })?.response?.data?.detail
        || 'Failed to update API key';
      toast({ title: detail, status: 'error' });
    }
    setSavingKey(false);
  };

  const handleRefreshModels = () => {
    if (!activeProvider) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.providerModels(activeProvider.id) });
    toast({ title: 'Refreshing model list…', status: 'info' });
  };

  const handleSaveVisionUrl = async () => {
    const cleaned = visionUrlInput.trim().replace(/\/+$/, '');
    if (!cleaned) return;
    if (!/^https?:\/\//i.test(cleaned)) {
      toast({ title: 'URL must start with http:// or https://', status: 'error' });
      return;
    }
    setSavingVisionUrl(true);
    try {
      await api.updateVisionUrl(cleaned);
      toast({ title: 'Vision API URL saved', status: 'success' });
      // Re-fetch the config so the displayed value is the persisted one.
      // Re-test connection so the System Status badge reflects the new URL.
      queryClient.invalidateQueries({ queryKey: queryKeys.config });
      void testVisionConnection();
    } catch (error: unknown) {
      const detail =
        (error as { response?: { data?: { detail?: string } } })?.response?.data?.detail
        || 'Failed to update Vision API URL';
      toast({ title: detail, status: 'error' });
    }
    setSavingVisionUrl(false);
  };

  if (configLoading && !embedded) {
    return <Skeleton height="500px" />;
  }

  return (
    <SimpleGrid columns={{ base: 1, lg: 2 }} spacing={6}>
      {/* System Status */}
      <Card>
        <CardHeader>
          <Heading size="md">System Status</Heading>
        </CardHeader>
        <CardBody>
          <VStack align="stretch" spacing={4}>
            <HStack justify="space-between">
              <HStack spacing={2}>
                <Server size={16} />
                <Text>Backend API</Text>
              </HStack>
              <Badge colorScheme={health?.status === 'healthy' ? 'green' : 'red'}>
                {health?.status || 'Unknown'}
              </Badge>
            </HStack>

            <HStack justify="space-between">
              <HStack spacing={2}>
                <Eye size={16} />
                <Text>Vision API</Text>
              </HStack>
              <HStack>
                {visionHealthy !== null && (
                  <Badge colorScheme={visionHealthy ? 'green' : 'red'}>
                    {visionHealthy ? 'Connected' : 'Disconnected'}
                  </Badge>
                )}
                <Button size="xs" onClick={testVisionConnection} isLoading={testingVision}>
                  Test
                </Button>
              </HStack>
            </HStack>

            <HStack justify="space-between">
              <HStack spacing={2}>
                <Brain size={16} />
                <Text>LLM Provider</Text>
              </HStack>
              <HStack>
                {llmStatus !== null && (
                  <Badge colorScheme={llmStatus.configured ? 'green' : 'yellow'}>
                    {llmStatus.configured ? 'Configured' : 'Not Configured'}
                  </Badge>
                )}
                <Button size="xs" onClick={testLLMConnection} isLoading={testingLLM}>
                  Test
                </Button>
              </HStack>
            </HStack>

            <Divider />

            <HStack justify="space-between">
              <HStack spacing={2}>
                <Database size={16} />
                <Text>Knowledge Base</Text>
              </HStack>
              <Badge colorScheme={kbSummary?.loaded ? 'green' : 'yellow'}>
                {kbSummary?.loaded ? `${kbSummary.total_evidence} records` : 'Not Loaded'}
              </Badge>
            </HStack>
          </VStack>
        </CardBody>
      </Card>

      {/* Vision Model */}
      <Card>
        <CardHeader>
          <HStack>
            <Cpu size={18} />
            <Heading size="md">Vision Model</Heading>
          </HStack>
        </CardHeader>
        <CardBody>
          <VStack align="stretch" spacing={4}>
            {visionInfo ? (
              <>
                <FormControl>
                  <FormLabel fontSize="sm">Currently loaded</FormLabel>
                  <HStack>
                    <Code p={2} borderRadius="md" flex={1} fontSize="sm">
                      {visionInfo.depth_model}
                    </Code>
                    <Badge colorScheme="green" flexShrink={0}>Active</Badge>
                  </HStack>
                </FormControl>

                <FormControl>
                  <FormLabel fontSize="sm">GPU</FormLabel>
                  <HStack spacing={2} flexWrap="wrap">
                    <Badge colorScheme={visionInfo.gpu_available ? 'green' : 'red'}>
                      {visionInfo.gpu_available ? 'CUDA' : 'CPU only'}
                    </Badge>
                    {visionInfo.gpu_name && (
                      <Text fontSize="sm" color="gray.500" noOfLines={1}>
                        {visionInfo.gpu_name}
                      </Text>
                    )}
                    {visionInfo.gpu_memory && (
                      <Badge colorScheme="purple">{visionInfo.gpu_memory}</Badge>
                    )}
                  </HStack>
                </FormControl>

                <Divider />

                <FormControl>
                  <FormLabel fontSize="sm">Available models</FormLabel>
                  <Select
                    value={visionInfo.depth_model}
                    isDisabled
                    size="sm"
                    fontFamily="mono"
                    fontSize="sm"
                  >
                    {(visionInfo.available_depth_models ?? []).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label} — {m.params_billions}B / {m.vram_gb}GB
                      </option>
                    ))}
                  </Select>
                </FormControl>

                <VStack align="stretch" spacing={2}>
                  {(visionInfo.available_depth_models ?? []).map((m) => {
                    const isActive = m.id === visionInfo.depth_model;
                    const fits =
                      visionInfo.gpu_memory_gb === null ||
                      visionInfo.gpu_memory_gb === undefined ||
                      visionInfo.gpu_memory_gb >= m.vram_gb;
                    return (
                      <Box
                        key={m.id}
                        borderWidth={1}
                        borderColor={isActive ? 'blue.400' : 'gray.200'}
                        borderRadius="md"
                        p={3}
                        bg={isActive ? 'blue.50' : 'transparent'}
                      >
                        <HStack justify="space-between" mb={1}>
                          <Text fontSize="sm" fontWeight="semibold">
                            {m.label}
                          </Text>
                          <HStack spacing={1}>
                            {isActive && <Badge colorScheme="blue" fontSize="xs">Active</Badge>}
                            {!fits && <Badge colorScheme="red" fontSize="xs">Insufficient VRAM</Badge>}
                          </HStack>
                        </HStack>
                        <Text fontSize="xs" color="gray.600" fontFamily="mono">
                          {m.id}
                        </Text>
                        <HStack mt={2} spacing={3} fontSize="xs" color="gray.600" flexWrap="wrap">
                          <Text>{m.params_billions}B params</Text>
                          <Text>·</Text>
                          <Text>{m.vram_gb}GB VRAM</Text>
                          <Text>·</Text>
                          <Text>sky: {m.sky_detection}</Text>
                        </HStack>
                        <Text fontSize="xs" color="gray.500" mt={1}>
                          {m.notes}
                        </Text>
                      </Box>
                    );
                  })}
                </VStack>

                <Box
                  borderLeftWidth={3}
                  borderColor="blue.400"
                  bg="blue.50"
                  px={3}
                  py={2}
                  borderRadius="sm"
                >
                  <Text fontSize="xs" color="gray.700">
                    To switch model: set{' '}
                    <Code fontSize="xs">VISION_DEPTH_MODEL</Code>{' '}
                    env var (e.g.{' '}
                    <Code fontSize="xs">DA3METRIC-LARGE</Code>{' '}
                    or{' '}
                    <Code fontSize="xs">DA3NESTED-GIANT-LARGE-1.1</Code>) and
                    restart the Vision API service.
                  </Text>
                </Box>
              </>
            ) : (
              <HStack>
                <Text fontSize="sm" color="gray.500">
                  Vision API not reachable.
                </Text>
                <Button size="xs" onClick={testVisionConnection} isLoading={testingVision}>
                  Retry
                </Button>
              </HStack>
            )}
          </VStack>
        </CardBody>
      </Card>

      {/* LLM Provider */}
      <Card>
        <CardHeader>
          <Heading size="md">LLM Provider</Heading>
        </CardHeader>
        <CardBody>
          <VStack align="stretch" spacing={4}>
            {/* Provider selector */}
            <FormControl>
              <FormLabel fontSize="sm">Provider</FormLabel>
              <Select
                value={activeProvider?.id || ''}
                onChange={(e) => handleSwitchProvider(e.target.value)}
                isDisabled={switchingProvider || providersLoading}
                size="sm"
              >
                {llmProviders?.map((p: LLMProviderInfo) => (
                  <option key={p.id} value={p.id}>
                    {p.name} {!p.configured ? '(no key)' : ''}
                  </option>
                ))}
              </Select>
            </FormControl>

            {/* Model selector */}
            {activeProvider && (() => {
              const usingDynamic = !!(dynamicModels && dynamicModels.length > 0);
              const modelList = usingDynamic
                ? dynamicModels!
                : (FALLBACK_MODELS[activeProvider.id] || []);
              return (
                <FormControl>
                  <FormLabel fontSize="sm">
                    <HStack spacing={2}>
                      <Text>Model</Text>
                      {modelsLoading && <Text as="span" fontSize="xs" color="gray.400">(loading...)</Text>}
                      {!modelsLoading && usingDynamic && (
                        <Badge colorScheme="green" fontSize="2xs" textTransform="none">
                          live · {modelList.length}
                        </Badge>
                      )}
                      {!modelsLoading && !usingDynamic && activeProvider.configured && (
                        <Badge colorScheme="yellow" fontSize="2xs" textTransform="none">
                          fallback list
                        </Badge>
                      )}
                      {!modelsLoading && !activeProvider.configured && (
                        <Badge colorScheme="gray" fontSize="2xs" textTransform="none">
                          add API key for live list
                        </Badge>
                      )}
                      <Button
                        size="2xs"
                        variant="link"
                        colorScheme="blue"
                        fontSize="2xs"
                        onClick={handleRefreshModels}
                        isDisabled={!activeProvider.configured || modelsLoading}
                        ml="auto"
                      >
                        Refresh
                      </Button>
                    </HStack>
                  </FormLabel>
                  <HStack>
                    <Select
                      value={customModel}
                      onChange={(e) => setCustomModel(e.target.value)}
                      size="sm"
                      fontFamily="mono"
                      fontSize="sm"
                    >
                      {modelList.map(m => (
                        <option key={m.id} value={m.id}>
                          {m.id}{m.label && m.label !== m.id ? ` — ${m.label}` : ''}
                        </option>
                      ))}
                      {/* Allow current model even if not in fetched list */}
                      {customModel && !modelList.some(m => m.id === customModel) && (
                        <option value={customModel}>{customModel} (current)</option>
                      )}
                    </Select>
                    <Button
                      size="sm"
                      colorScheme="blue"
                      onClick={() => handleSwitchProvider(activeProvider.id, customModel)}
                      isLoading={switchingProvider}
                      isDisabled={customModel === activeProvider.current_model}
                      flexShrink={0}
                    >
                      Apply
                    </Button>
                  </HStack>
                </FormControl>
              );
            })()}

            <Divider />

            {/* API Key */}
            {activeProvider && (
              <FormControl>
                <FormLabel fontSize="sm">API Key ({activeProvider.name})</FormLabel>
                <HStack>
                  <Input
                    type="password"
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    placeholder={activeProvider.configured ? '••••••••  (configured)' : 'Enter API key...'}
                    size="sm"
                    fontFamily="mono"
                  />
                  <Button
                    size="sm"
                    colorScheme="green"
                    onClick={handleUpdateApiKey}
                    isLoading={savingKey}
                    isDisabled={!apiKeyInput.trim()}
                    flexShrink={0}
                  >
                    Save
                  </Button>
                </HStack>
                <Text fontSize="xs" color="gray.500" mt={1}>
                  Saved to .env file and persisted across restarts.
                </Text>
              </FormControl>
            )}

            {/* Test Connection */}
            {activeProvider && (
              <HStack>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={testLLMConnection}
                  isLoading={testingLLM}
                  w="full"
                >
                  Test Connection
                </Button>
                {llmStatus && (
                  <Badge colorScheme={llmStatus.configured ? 'green' : 'red'} flexShrink={0}>
                    {llmStatus.configured ? `OK — ${llmStatus.model}` : 'Failed'}
                  </Badge>
                )}
              </HStack>
            )}

            <Divider />

            {/* Provider status list */}
            <Text fontSize="xs" fontWeight="semibold" color="gray.500" textTransform="uppercase">
              Providers
            </Text>
            {llmProviders?.map((p: LLMProviderInfo) => (
              <HStack key={p.id} justify="space-between">
                <HStack>
                  <Text fontSize="sm">{p.name}</Text>
                  {p.active && <Badge colorScheme="blue" fontSize="xs">Active</Badge>}
                </HStack>
                <Badge colorScheme={p.configured ? 'green' : 'gray'} fontSize="xs">
                  {p.configured ? p.current_model : 'No key'}
                </Badge>
              </HStack>
            ))}
          </VStack>
        </CardBody>
      </Card>

      {/* Configuration */}
      <Card>
        <CardHeader>
          <Heading size="md">Configuration</Heading>
        </CardHeader>
        <CardBody>
          <VStack align="stretch" spacing={4}>
            <FormControl>
              <FormLabel>Vision API URL</FormLabel>
              <HStack>
                <Input
                  value={visionUrlInput}
                  onChange={(e) => setVisionUrlInput(e.target.value)}
                  placeholder="http://127.0.0.1:8000"
                  size="sm"
                  fontFamily="mono"
                />
                <Button
                  size="sm"
                  colorScheme="green"
                  onClick={handleSaveVisionUrl}
                  isLoading={savingVisionUrl}
                  isDisabled={
                    !visionUrlInput.trim()
                    || visionUrlInput.trim().replace(/\/+$/, '') === config?.vision_api_url
                  }
                  flexShrink={0}
                >
                  Save
                </Button>
              </HStack>
              <Text fontSize="xs" color="gray.500" mt={1}>
                Saved to .env and applied immediately. Use Test in System Status above to verify.
              </Text>
            </FormControl>

            <FormControl>
              <FormLabel>Data Directory</FormLabel>
              <Code p={2} borderRadius="md" w="full">
                {config?.data_dir}
              </Code>
            </FormControl>

            <FormControl>
              <FormLabel>Metrics Code Directory</FormLabel>
              <Code p={2} borderRadius="md" w="full">
                {config?.metrics_code_dir}
              </Code>
            </FormControl>

            <FormControl>
              <FormLabel>Knowledge Base Directory</FormLabel>
              <Code p={2} borderRadius="md" w="full">
                {config?.knowledge_base_dir}
              </Code>
            </FormControl>
          </VStack>
        </CardBody>
      </Card>

      {/* Knowledge Base Details */}
      {kbSummary && (
        <Card>
          <CardHeader>
            <Heading size="md">Knowledge Base</Heading>
          </CardHeader>
          <CardBody>
            <SimpleGrid columns={2} spacing={4}>
              <Box>
                <Text fontSize="sm" color="gray.500">Evidence Records</Text>
                <Text fontSize="2xl" fontWeight="bold">{kbSummary.total_evidence}</Text>
              </Box>
              <Box>
                <Text fontSize="sm" color="gray.500">Indicators with Evidence</Text>
                <Text fontSize="2xl" fontWeight="bold">{kbSummary.indicators_with_evidence}</Text>
              </Box>
              <Box>
                <Text fontSize="sm" color="gray.500">Dimensions</Text>
                <Text fontSize="2xl" fontWeight="bold">{kbSummary.dimensions_with_evidence}</Text>
              </Box>
              <Box>
                <Text fontSize="sm" color="gray.500">IOM Records</Text>
                <Text fontSize="2xl" fontWeight="bold">{kbSummary.iom_records}</Text>
              </Box>
            </SimpleGrid>

            <Divider my={4} />

            <Text fontSize="sm" color="gray.500" mb={2}>Appendix Sections:</Text>
            <Box maxH="100px" overflowY="auto">
              <Text fontSize="xs" fontFamily="mono">
                {(kbSummary.appendix_sections ?? []).join(', ')}
              </Text>
            </Box>
          </CardBody>
        </Card>
      )}

      {/* About */}
      <Card>
        <CardHeader>
          <Heading size="md">About</Heading>
        </CardHeader>
        <CardBody>
          <VStack align="stretch" spacing={2}>
            <HStack justify="space-between">
              <Text>Application</Text>
              <Text fontWeight="bold">SceneRx</Text>
            </HStack>
            <HStack justify="space-between">
              <Text>Version</Text>
              <Badge>1.0.0</Badge>
            </HStack>
            <HStack justify="space-between">
              <Text>Backend</Text>
              <Badge colorScheme="blue">FastAPI</Badge>
            </HStack>
            <HStack justify="space-between">
              <Text>Frontend</Text>
              <Badge colorScheme="cyan">React + TypeScript</Badge>
            </HStack>
          </VStack>
        </CardBody>
      </Card>
    </SimpleGrid>
  );
}

export default SettingsContent;
