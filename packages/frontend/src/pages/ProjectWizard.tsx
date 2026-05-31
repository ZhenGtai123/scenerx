import { useState, useEffect } from 'react';
import {
  Box,
  Heading,
  Button,
  VStack,
  HStack,
  FormControl,
  FormLabel,
  FormHelperText,
  Alert,
  AlertIcon,
  Input,
  Textarea,
  Select,
  SimpleGrid,
  Card,
  CardHeader,
  CardBody,
  Text,
  Checkbox,
  Tag,
  TagLabel,
  Wrap,
  WrapItem,
} from '@chakra-ui/react';
import {
  ClipboardList,
  Globe,
  Target,
  Map,
  Eye,
  Footprints,
  Thermometer,
  Heart,
  Brain,
  Users,
  Plus,
} from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import api from '../api';
import useAppToast from '../hooks/useAppToast';
import PageShell from '../components/PageShell';
import EncodingInfoPopover from '../components/EncodingInfoPopover';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { useEncodingSections } from '../hooks/useApi';
import type { EncodingEntry, SpatialRelation } from '../types';

// ============ Constants ============

// Icon override for performance-dimension cards. The names + definitions
// themselves come from the knowledge-base C_performance section.
const PRF_ICON_BY_CODE: Record<string, React.ElementType> = {
  PRF_AES: Eye,
  PRF_RST: Heart,
  PRF_EMO: Brain,
  PRF_THR: Thermometer,
  PRF_USE: Footprints,
  PRF_SOC: Users,
};

const DEFAULT_ZONE_TYPES = [
  { id: 'entrance', name: 'Entrance/Gateway', def: 'Main entry points, gateways' },
  { id: 'plaza', name: 'Plaza/Square', def: 'Gathering plazas, open paved spaces' },
  { id: 'lawn', name: 'Lawn/Open Space', def: 'Open lawns, flexible activity fields' },
  { id: 'playground', name: 'Playground', def: 'Children play zones' },
  { id: 'fitness', name: 'Fitness/Sports', def: 'Sports courts, fitness routes' },
  { id: 'waterfront', name: 'Waterfront', def: 'Water-edge promenades' },
  { id: 'woodland', name: 'Woodland/Forest', def: 'Wooded areas, forest' },
  { id: 'garden', name: 'Garden/Planting', def: 'Gardens, planting beds' },
  { id: 'path', name: 'Path/Corridor', def: 'Main circulation corridors' },
  { id: 'rest', name: 'Rest/Seating', def: 'Rest nodes, seating areas' },
];

// ============ Section Title ============

function SectionTitle({ icon: Icon, title, subtitle }: { icon: React.ElementType; title: string; subtitle: string }) {
  return (
    <HStack>
      <Box p={2} borderRadius="lg" bg="brand.50">
        <Icon size={20} color="var(--chakra-colors-brand-600)" />
      </Box>
      <Box>
        <Heading size="md">{title}</Heading>
        <Text fontSize="sm" color="gray.500">{subtitle}</Text>
      </Box>
    </HStack>
  );
}

// FormLabel that pairs with an EncodingInfoPopover trigger.
function LabelWithInfo({
  children,
  title,
  entries,
  selectedCode,
}: {
  children: React.ReactNode;
  title: string;
  entries: EncodingEntry[];
  selectedCode?: string;
}) {
  return (
    <HStack mb={2} spacing={1} align="center">
      <FormLabel mb={0}>{children}</FormLabel>
      <EncodingInfoPopover title={title} entries={entries} selectedCode={selectedCode} />
    </HStack>
  );
}

// ============ Types ============

interface SpatialZone {
  id: string;
  name: string;
  types: string[];
  area?: number;
  status?: string;
  description?: string;
}

// Canonical zone-to-zone relation vocabulary.
// Drawn from landscape-architecture spatial-syntax conventions and used
// downstream by the analysis service to constrain cross-zone interpretation:
//   - adjacent / connected / nearby  : permit cross-zone correlation claims
//   - contains                       : hierarchical (parent zone aggregates child)
//   - distant                        : explicit exclusion marker against
//                                       spurious spatial-pattern claims
const RELATION_TYPES: { id: string; name: string; defaultDirection: 'single' | 'bidirectional' }[] = [
  { id: 'adjacent',  name: 'Adjacent (share boundary)',          defaultDirection: 'bidirectional' },
  { id: 'nearby',    name: 'Nearby (within visual range)',       defaultDirection: 'bidirectional' },
  { id: 'connected', name: 'Connected (path / circulation)',     defaultDirection: 'bidirectional' },
  { id: 'contains',  name: 'Contains (hierarchical)',            defaultDirection: 'single' },
  { id: 'distant',   name: 'Distant (no direct interaction)',    defaultDirection: 'bidirectional' },
];

// ============ Component ============

function ProjectWizard() {
  const { projectId } = useParams<{ projectId: string }>();
  const isEditMode = !!projectId;
  const navigate = useNavigate();
  const toast = useAppToast();
  const queryClient = useQueryClient();

  // Knowledge-base codebook (single source of truth for the 6 dropdown sections)
  const { data: encoding } = useEncodingSections();
  const koppenEntries: EncodingEntry[] = encoding?.K_climate ?? [];
  const countryEntries: EncodingEntry[] = encoding?.E_countries ?? [];
  const spaceTypeEntries: EncodingEntry[] = encoding?.E_settings ?? [];
  const lczEntries: EncodingEntry[] = encoding?.L_lcz ?? [];
  const ageEntries: EncodingEntry[] = encoding?.M_age_groups ?? [];
  const performanceEntries: EncodingEntry[] = encoding?.C_performance ?? [];
  const subdimensionEntries: EncodingEntry[] = encoding?.C_subdimensions ?? [];

  const findEntry = (entries: EncodingEntry[], code: string) =>
    entries.find((e) => e.code === code);

  // Loading state for edit mode
  const [loading, setLoading] = useState(isEditMode);

  // Project Info
  const [projectName, setProjectName] = useState('');
  const [projectLocation, setProjectLocation] = useState('');

  // Site Context
  const [koppenZone, setKoppenZone] = useState('');
  const [country, setCountry] = useState('');
  const [spaceType, setSpaceType] = useState('');
  const [lczType, setLczType] = useState('');
  const [ageGroup, setAgeGroup] = useState('');

  // Performance Goals
  const [designBrief, setDesignBrief] = useState('');
  const [selectedDimensions, setSelectedDimensions] = useState<string[]>([]);
  const [selectedSubdimensions, setSelectedSubdimensions] = useState<string[]>([]);

  // Spatial Zones
  const [zones, setZones] = useState<SpatialZone[]>([]);
  const [zoneTypes] = useState(DEFAULT_ZONE_TYPES);

  // Zone-to-zone relations (graph edges between spatial_zones).
  // Empty array = zones treated as independent by downstream analysis.
  const [relations, setRelations] = useState<SpatialRelation[]>([]);

  // Saving
  const [saving, setSaving] = useState(false);

  // When a parent performance dimension is unchecked, drop any of its sub-dimensions
  // so we never persist orphan PRS_* codes whose PRF_* parent is not selected.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- We're pruning subdimensions whose parent was just unchecked; the result is real persisted state the user can re-toggle, not a derived render value, so useMemo would not fit.
    setSelectedSubdimensions((prev) => {
      if (prev.length === 0) return prev;
      const allowedParents = new Set(selectedDimensions);
      const next = prev.filter((sd) => {
        const entry = subdimensionEntries.find((e) => e.code === sd);
        return entry?.parent_dim ? allowedParents.has(entry.parent_dim) : false;
      });
      return next.length === prev.length ? prev : next;
    });
  }, [selectedDimensions, subdimensionEntries]);

  // Load existing project data in edit mode
  useEffect(() => {
    if (isEditMode && projectId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Sync external system (server-side project) into form state on mount; cannot be a derived value.
      setLoading(true);
      api.projects.get(projectId)
        .then((res) => {
          const project = res.data;
          setProjectName(project.project_name);
          setProjectLocation(project.project_location || '');
          setKoppenZone(project.koppen_zone_id || '');
          setCountry(project.country_id || '');
          setSpaceType(project.space_type_id || '');
          setLczType(project.lcz_type_id || '');
          setAgeGroup(project.age_group_id || '');
          setDesignBrief(project.design_brief || '');
          setSelectedDimensions(project.performance_dimensions || []);
          setSelectedSubdimensions(project.subdimensions || []);

          const loadedZones: SpatialZone[] = (project.spatial_zones || []).map((z: { zone_id: string; zone_name: string; zone_types?: string[]; area?: number; status?: string; description?: string }) => ({
            id: z.zone_id,
            name: z.zone_name,
            types: z.zone_types || [],
            area: z.area,
            status: z.status || 'existing',
            description: z.description || '',
          }));
          setZones(loadedZones);
          setRelations(project.spatial_relations || []);
        })
        .catch((error) => {
          console.error('Failed to load project:', error);
          toast({ title: 'Failed to load project', status: 'error' });
          navigate('/projects');
        })
        .finally(() => {
          setLoading(false);
        });
    }
  }, [isEditMode, projectId, navigate, toast]);

  // ============ Zone Functions ============

  const addZone = () => {
    const newZone: SpatialZone = {
      id: `zone_${Date.now()}`,
      name: '',
      types: [],
      status: 'existing',
    };
    setZones([...zones, newZone]);
  };

  const updateZone = (id: string, updates: Partial<SpatialZone>) => {
    setZones(zones.map(z => z.id === id ? { ...z, ...updates } : z));
  };

  const removeZone = (id: string) => {
    setZones(prev => prev.filter(z => z.id !== id));
  };

  const toggleZoneType = (zoneId: string, typeId: string) => {
    const zone = zones.find(z => z.id === zoneId);
    if (!zone) return;

    const newTypes = zone.types.includes(typeId)
      ? zone.types.filter(t => t !== typeId)
      : [...zone.types, typeId];

    updateZone(zoneId, { types: newTypes });
  };

  // ============ Relation Functions ============

  const addRelation = () => {
    if (zones.length < 2) {
      toast({ title: 'Add at least two zones before declaring a relation', status: 'info' });
      return;
    }
    setRelations([
      ...relations,
      {
        from_zone: zones[0].id,
        to_zone: zones[1].id,
        relation_type: 'adjacent',
        direction: 'bidirectional',
      },
    ]);
  };

  const updateRelation = (index: number, updates: Partial<SpatialRelation>) => {
    setRelations(relations.map((r, i) => (i === index ? { ...r, ...updates } : r)));
  };

  const removeRelation = (index: number) => {
    setRelations(prev => prev.filter((_, i) => i !== index));
  };

  // When a zone is removed, drop any relations that referenced it so we
  // never persist dangling from_zone / to_zone ids to the API.
  useEffect(() => {
    const validIds = new Set(zones.map(z => z.id));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Pruning relations whose endpoint zone was just deleted; the result is real persisted state, not a derived render value.
    setRelations(prev => {
      const filtered = prev.filter(r => validIds.has(r.from_zone) && validIds.has(r.to_zone));
      return filtered.length === prev.length ? prev : filtered;
    });
  }, [zones]);

  // ============ Save Function ============

  const handleSave = async () => {
    if (!projectName.trim()) {
      toast({ title: 'Project name is required', status: 'warning' });
      return;
    }

    // Soft-warn on empty zones: the project can be saved, but the next step
    // (image upload) will block until at least one zone exists, and the
    // StepIndicator's Project box will stay grey. Surface that here so the
    // user doesn't navigate away thinking they're done. Skipped on edits
    // since the user is intentionally re-saving an existing project.
    if (!isEditMode && zones.length === 0) {
      const proceed = window.confirm(
        "You haven't defined any spatial zones yet.\n\n"
        + 'Image uploads need at least one zone for assignment, and the Project '
        + 'step will stay incomplete until you add one.\n\n'
        + 'Save anyway? (You can edit and add zones later.)'
      );
      if (!proceed) return;
    }

    setSaving(true);
    try {
      const projectData = {
        project_name: projectName,
        project_location: projectLocation,
        koppen_zone_id: koppenZone,
        country_id: country,
        space_type_id: spaceType,
        lcz_type_id: lczType,
        age_group_id: ageGroup,
        design_brief: designBrief,
        performance_dimensions: selectedDimensions,
        subdimensions: selectedSubdimensions,
        spatial_zones: zones.map(z => ({
          zone_id: z.id,
          zone_name: z.name,
          zone_types: z.types,
          area: z.area,
          status: z.status,
          description: z.description,
        })),
        // Drop self-loops at save time; UI surfaces an inline error but
        // we never want them to reach the API.
        spatial_relations: relations.filter(r => r.from_zone !== r.to_zone),
      };

      let savedProjectId: string;

      if (isEditMode && projectId) {
        await api.projects.update(projectId, projectData);
        savedProjectId = projectId;

      } else {
        const response = await api.projects.create(projectData);
        savedProjectId = response.data.id;
      }

      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['project', savedProjectId] });

      toast({
        title: isEditMode ? 'Project updated successfully' : 'Project created successfully',
        status: 'success',
      });

      navigate(`/projects/${savedProjectId}`);
    } catch {
      toast({
        title: isEditMode ? 'Failed to update project' : 'Failed to create project',
        status: 'error',
      });
    }
    setSaving(false);
  };

  return (
    <PageShell isLoading={loading} loadingText="Loading project...">
      {/* Header */}
      <Box textAlign="center" mb={6}>
        <Heading size="lg">{isEditMode ? 'Edit Project' : 'Create New Project'}</Heading>
        <Text color="gray.600" mt={1} fontSize="sm">
          Define project context, performance goals, and spatial zones
        </Text>
      </Box>

      <VStack spacing={6} align="stretch">
        {/* Section 1: Project Information */}
        <Card>
          <CardHeader>
            <SectionTitle icon={ClipboardList} title="Project Information" subtitle="Basic project details" />
          </CardHeader>
          <CardBody>
            <SimpleGrid columns={{ base: 1, md: 2 }} spacing={4}>
              <FormControl isRequired>
                <FormLabel>Project Name</FormLabel>
                <Input
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder="e.g., Central Park Renovation"
                />
                <FormHelperText fontSize="xs">
                  Shown on every report cover, AI report title, and PDF filename. 4–8 words; avoid abbreviations.
                </FormHelperText>
              </FormControl>
              <FormControl>
                <FormLabel>Project Location</FormLabel>
                <Input
                  value={projectLocation}
                  onChange={(e) => setProjectLocation(e.target.value)}
                  placeholder="e.g., Shenzhen, China"
                />
                <FormHelperText fontSize="xs">
                  Display only — does not feed any algorithm. Use "City, Country" form.
                </FormHelperText>
              </FormControl>
            </SimpleGrid>
          </CardBody>
        </Card>

        {/* Section 2: Site Context */}
        <Card>
          <CardHeader>
            <SectionTitle icon={Globe} title="Site Context" subtitle="Climate, setting, and user context" />
          </CardHeader>
          <CardBody>
            <SimpleGrid columns={{ base: 1, md: 2 }} spacing={4}>
              <FormControl>
                <LabelWithInfo
                  title="Köppen Climate Zones"
                  entries={koppenEntries}
                  selectedCode={koppenZone}
                >
                  Köppen Climate Zone
                </LabelWithInfo>
                <Select value={koppenZone} onChange={(e) => setKoppenZone(e.target.value)} placeholder="Select climate">
                  {koppenEntries.map(k => (
                    <option key={k.code} value={k.code}>{k.code} — {k.name}</option>
                  ))}
                </Select>
                {findEntry(koppenEntries, koppenZone)?.definition && (
                  <Text fontSize="xs" color="gray.500" mt={1} noOfLines={2}>
                    {findEntry(koppenEntries, koppenZone)!.definition}
                  </Text>
                )}
                <FormHelperText fontSize="xs">
                  Drives Stage 1 indicator transferability weighting and Stage 3 strategy filtering — strongly recommended.
                </FormHelperText>
              </FormControl>
              <FormControl>
                <LabelWithInfo
                  title="Country / Region"
                  entries={countryEntries}
                  selectedCode={country}
                >
                  Country/Region
                </LabelWithInfo>
                <Select value={country} onChange={(e) => setCountry(e.target.value)} placeholder="Select country">
                  {countryEntries.map(c => (
                    <option key={c.code} value={c.code}>{c.name}</option>
                  ))}
                </Select>
                <FormHelperText fontSize="xs">
                  Pairs with Climate Zone for Stage 3 transferability weighting.
                </FormHelperText>
              </FormControl>
              <FormControl>
                <LabelWithInfo
                  title="Space Types (Setting)"
                  entries={spaceTypeEntries}
                  selectedCode={spaceType}
                >
                  Space Type
                </LabelWithInfo>
                <Select value={spaceType} onChange={(e) => setSpaceType(e.target.value)} placeholder="Select type">
                  {spaceTypeEntries.map(s => (
                    <option key={s.code} value={s.code}>{s.name}</option>
                  ))}
                </Select>
                {findEntry(spaceTypeEntries, spaceType)?.definition && (
                  <Text fontSize="xs" color="gray.500" mt={1} noOfLines={2}>
                    {findEntry(spaceTypeEntries, spaceType)!.definition}
                  </Text>
                )}
                <FormHelperText fontSize="xs">
                  Decides which Stage 4 IOM intervention prototypes apply (street vs park vs plaza). Pick the dominant type if mixed.
                </FormHelperText>
              </FormControl>
              <FormControl>
                <LabelWithInfo
                  title="Local Climate Zones (LCZ)"
                  entries={lczEntries}
                  selectedCode={lczType}
                >
                  Local Climate Zone (LCZ)
                </LabelWithInfo>
                <Select value={lczType} onChange={(e) => setLczType(e.target.value)} placeholder="Select LCZ">
                  {lczEntries.map(l => (
                    <option key={l.code} value={l.code}>{l.name}</option>
                  ))}
                </Select>
                {findEntry(lczEntries, lczType)?.definition && (
                  <Text fontSize="xs" color="gray.500" mt={1} noOfLines={2}>
                    {findEntry(lczEntries, lczType)!.definition}
                  </Text>
                )}
                <FormHelperText fontSize="xs">
                  Finer-grained than Köppen — Stage 1 uses it to filter indicator baselines (dense urban vs forest).
                </FormHelperText>
              </FormControl>
              <FormControl>
                <LabelWithInfo
                  title="Target User / Age Groups"
                  entries={ageEntries}
                  selectedCode={ageGroup}
                >
                  Target User Group
                </LabelWithInfo>
                <Select value={ageGroup} onChange={(e) => setAgeGroup(e.target.value)} placeholder="Select group">
                  {ageEntries.map(a => (
                    <option key={a.code} value={a.code}>{a.name}</option>
                  ))}
                </Select>
                <FormHelperText fontSize="xs">
                  Influences Stage 4 strategy preferences (older users → accessibility/rest; younger → activity/social).
                </FormHelperText>
              </FormControl>
            </SimpleGrid>
          </CardBody>
        </Card>

        {/* Section 3: Performance Goals */}
        <Card>
          <CardHeader>
            <SectionTitle icon={Target} title="Performance Goals" subtitle="Select target performance dimensions" />
          </CardHeader>
          <CardBody>
            <FormControl mb={4}>
              <FormLabel>Design Brief</FormLabel>
              <Textarea
                value={designBrief}
                onChange={(e) => setDesignBrief(e.target.value)}
                placeholder="Describe the performance objectives, constraints, and expected outcomes..."
                rows={3}
              />
              <FormHelperText fontSize="xs">
                Fed directly into Stage 1 LLM indicator recommendation and Stage 3 Agent A diagnosis. 200–500 words covering: (1) current problem, (2) design constraints, (3) expected outcome. The more specific, the better the recommendations.
              </FormHelperText>
            </FormControl>

            <HStack mb={2} spacing={1} align="center">
              <FormLabel mb={0}>Performance Dimensions</FormLabel>
              <EncodingInfoPopover
                title="Performance Dimensions"
                entries={performanceEntries}
              />
            </HStack>
            <SimpleGrid columns={{ base: 1, md: 2, lg: 3 }} spacing={3}>
              {performanceEntries.map(dim => {
                const DimIcon = PRF_ICON_BY_CODE[dim.code] ?? Target;
                const isSelected = selectedDimensions.includes(dim.code);
                return (
                  <Box
                    key={dim.code}
                    p={3}
                    borderWidth={2}
                    borderRadius="lg"
                    borderColor={isSelected ? 'blue.500' : 'gray.200'}
                    bg={isSelected ? 'blue.50' : 'white'}
                    cursor="pointer"
                    onClick={() => {
                      setSelectedDimensions(prev =>
                        prev.includes(dim.code)
                          ? prev.filter(d => d !== dim.code)
                          : [...prev, dim.code]
                      );
                    }}
                    _hover={{ borderColor: 'blue.300' }}
                    transition="all 0.15s"
                  >
                    <HStack align="flex-start">
                      <Checkbox
                        isChecked={isSelected}
                        onChange={() => {}}
                        pointerEvents="none"
                        mt={1}
                      />
                      <Box color="brand.600" flexShrink={0} mt={1}>
                        <DimIcon size={16} />
                      </Box>
                      <Box>
                        <Text fontWeight="bold" fontSize="sm">
                          {dim.name}
                        </Text>
                        <Text fontSize="xs" color="gray.500" noOfLines={3}>
                          {dim.definition}
                        </Text>
                      </Box>
                    </HStack>
                  </Box>
                );
              })}
            </SimpleGrid>

            {selectedDimensions.length > 0 && subdimensionEntries.length > 0 && (
              <Box mt={6}>
                <HStack mb={2} spacing={1} align="center">
                  <FormLabel mb={0}>Sub-dimensions (Optional)</FormLabel>
                  <EncodingInfoPopover
                    title="Sub-dimensions"
                    entries={subdimensionEntries}
                  />
                </HStack>
                <Text fontSize="xs" color="gray.500" mb={3}>
                  Refines evidence retrieval. Picking none falls back to dimension-level retrieval.
                </Text>
                {(() => {
                  const visible = subdimensionEntries.filter(
                    (sd) => sd.parent_dim && selectedDimensions.includes(sd.parent_dim)
                  );
                  if (visible.length === 0) return null;
                  const grouped = selectedDimensions
                    .map((dim) => ({
                      dim,
                      dimName: performanceEntries.find((p) => p.code === dim)?.name ?? dim,
                      items: visible.filter((sd) => sd.parent_dim === dim),
                    }))
                    .filter((g) => g.items.length > 0);
                  return (
                    <VStack align="stretch" spacing={3}>
                      {grouped.map(({ dim, dimName, items }) => (
                        <Box key={dim}>
                          <Text fontSize="xs" fontWeight="bold" color="gray.600" mb={1}>
                            {dimName}
                          </Text>
                          <Wrap spacing={2}>
                            {items.map((sd) => {
                              const checked = selectedSubdimensions.includes(sd.code);
                              return (
                                <WrapItem key={sd.code}>
                                  <Tag
                                    size="md"
                                    cursor="pointer"
                                    variant={checked ? 'solid' : 'outline'}
                                    colorScheme={checked ? 'blue' : 'gray'}
                                    onClick={() =>
                                      setSelectedSubdimensions((prev) =>
                                        prev.includes(sd.code)
                                          ? prev.filter((c) => c !== sd.code)
                                          : [...prev, sd.code]
                                      )
                                    }
                                    title={sd.definition || sd.name}
                                  >
                                    <TagLabel>{sd.name}</TagLabel>
                                  </Tag>
                                </WrapItem>
                              );
                            })}
                          </Wrap>
                        </Box>
                      ))}
                    </VStack>
                  );
                })()}
              </Box>
            )}
          </CardBody>
        </Card>

        {/* Section 4: Spatial Zones */}
        {/* v4.x — ErrorBoundary around the zone editor: this is the most
            crash-prone section in ProjectWizard (add/remove zones triggers
            list mutations + form re-renders, area/zone-type tag manipulation
            can produce undefined intermediate states). A crash here doesn't
            take out the relations editor below or the form sections above. */}
        <ErrorBoundary label="Spatial Zones editor">
        <Card>
          <CardHeader>
            <HStack justify="space-between">
              <SectionTitle icon={Map} title="Spatial Zones" subtitle="Define analysis zones and their characteristics" />
              <Button colorScheme="blue" size="sm" onClick={addZone} leftIcon={<Plus size={14} />}>
                Add Zone
              </Button>
            </HStack>
          </CardHeader>
          <CardBody>
            {zones.length === 0 ? (
              <Box textAlign="center" py={8} color="gray.500">
                <Text>No zones defined yet. Click "Add Zone" to create your first zone.</Text>
              </Box>
            ) : (
              <VStack spacing={4} align="stretch">
                {zones.map((zone) => (
                  <Box
                    key={zone.id}
                    p={4}
                    borderWidth={1}
                    borderRadius="lg"
                    bg="gray.50"
                  >
                    <SimpleGrid columns={{ base: 1, md: 3 }} spacing={4} mb={3}>
                      <FormControl>
                        <FormLabel fontSize="sm">Zone Name</FormLabel>
                        <Input
                          size="sm"
                          value={zone.name}
                          onChange={(e) => updateZone(zone.id, { name: e.target.value })}
                          placeholder="e.g., Entrance Plaza"
                        />
                        <FormHelperText fontSize="2xs">
                          Shown on all chart labels, strategy group titles, and report archetypes. Use a spatial name, not "Zone 1".
                        </FormHelperText>
                      </FormControl>
                      <FormControl>
                        <FormLabel fontSize="sm">Area (m²)</FormLabel>
                        <Input
                          size="sm"
                          type="number"
                          value={zone.area || ''}
                          onChange={(e) => updateZone(zone.id, { area: parseFloat(e.target.value) || undefined })}
                          placeholder="Optional"
                        />
                        <FormHelperText fontSize="2xs">
                          Display-only metadata. Does not currently feed any algorithm — leave blank if unknown.
                        </FormHelperText>
                      </FormControl>
                      <FormControl>
                        <FormLabel fontSize="sm">Status</FormLabel>
                        <Select
                          size="sm"
                          value={zone.status || ''}
                          onChange={(e) => updateZone(zone.id, { status: e.target.value })}
                        >
                          <option value="existing">Existing</option>
                          <option value="planned">Planned</option>
                          <option value="renovation">Renovation</option>
                        </Select>
                      </FormControl>
                    </SimpleGrid>

                    <FormControl mb={3}>
                      <FormLabel fontSize="sm">Zone Types</FormLabel>
                      <Wrap>
                        {zoneTypes.map(type => (
                          <WrapItem key={type.id}>
                            <Tag
                              size="md"
                              variant={zone.types.includes(type.id) ? 'solid' : 'outline'}
                              colorScheme={zone.types.includes(type.id) ? 'blue' : 'gray'}
                              cursor="pointer"
                              onClick={() => toggleZoneType(zone.id, type.id)}
                            >
                              <TagLabel>{type.name}</TagLabel>
                            </Tag>
                          </WrapItem>
                        ))}
                      </Wrap>
                    </FormControl>

                    <HStack justify="space-between">
                      <FormControl flex={1}>
                        <Input
                          size="sm"
                          value={zone.description || ''}
                          onChange={(e) => updateZone(zone.id, { description: e.target.value })}
                          placeholder="Description or current issues..."
                        />
                      </FormControl>
                      <Button
                        size="sm"
                        colorScheme="red"
                        variant="ghost"
                        onClick={() => removeZone(zone.id)}
                      >
                        Remove
                      </Button>
                    </HStack>
                  </Box>
                ))}
              </VStack>
            )}
          </CardBody>
        </Card>
        </ErrorBoundary>

        {/* Section 4b: Zone-to-Zone Relations.
            Declares the spatial graph between zones so downstream analysis
            (within-zone clustering, cross-zone correlation claims) can be
            conditioned on the declared edges rather than treating every
            zone pair as independent. Empty = independent (legacy behaviour). */}
        <ErrorBoundary label="Zone Relations editor">
        <Card>
          <CardHeader>
            <HStack justify="space-between">
              <SectionTitle
                icon={Map}
                title="Zone-to-Zone Relations"
                subtitle="Declare how zones relate; constrains cross-zone interpretation downstream"
              />
              <Button
                colorScheme="blue"
                size="sm"
                onClick={addRelation}
                leftIcon={<Plus size={14} />}
                isDisabled={zones.length < 2}
              >
                Add Relation
              </Button>
            </HStack>
          </CardHeader>
          <CardBody>
            {zones.length < 2 ? (
              <Box textAlign="center" py={4} color="gray.500">
                <Text fontSize="sm">Define at least two zones above before declaring relations.</Text>
              </Box>
            ) : relations.length === 0 ? (
              <Box textAlign="center" py={4} color="gray.500">
                <Text fontSize="sm">
                  No relations declared yet — downstream cross-zone analysis will treat zones as independent.
                </Text>
              </Box>
            ) : (
              <VStack spacing={3} align="stretch">
                {relations.map((rel, i) => {
                  const isSelfLoop = rel.from_zone === rel.to_zone;
                  return (
                    <Box
                      key={`${rel.from_zone}-${rel.to_zone}-${i}`}
                      p={3}
                      borderWidth={1}
                      borderRadius="md"
                      borderColor={isSelfLoop ? 'red.300' : 'gray.200'}
                      bg="gray.50"
                    >
                      <SimpleGrid columns={{ base: 1, md: 5 }} spacing={3} alignItems="end">
                        <FormControl>
                          <FormLabel fontSize="xs">From Zone</FormLabel>
                          <Select
                            size="sm"
                            value={rel.from_zone}
                            onChange={(e) => updateRelation(i, { from_zone: e.target.value })}
                          >
                            {zones.map(z => (
                              <option key={z.id} value={z.id}>{z.name || z.id}</option>
                            ))}
                          </Select>
                        </FormControl>
                        <FormControl>
                          <FormLabel fontSize="xs">Relation</FormLabel>
                          <Select
                            size="sm"
                            value={rel.relation_type}
                            onChange={(e) => {
                              const next = RELATION_TYPES.find(t => t.id === e.target.value);
                              updateRelation(i, {
                                relation_type: e.target.value,
                                direction: next?.defaultDirection ?? 'bidirectional',
                              });
                            }}
                          >
                            {RELATION_TYPES.map(t => (
                              <option key={t.id} value={t.id}>{t.name}</option>
                            ))}
                          </Select>
                        </FormControl>
                        <FormControl>
                          <FormLabel fontSize="xs">To Zone</FormLabel>
                          <Select
                            size="sm"
                            value={rel.to_zone}
                            onChange={(e) => updateRelation(i, { to_zone: e.target.value })}
                          >
                            {zones.map(z => (
                              <option key={z.id} value={z.id}>{z.name || z.id}</option>
                            ))}
                          </Select>
                        </FormControl>
                        <FormControl>
                          <FormLabel fontSize="xs">Direction</FormLabel>
                          <Select
                            size="sm"
                            value={rel.direction || 'single'}
                            onChange={(e) => updateRelation(i, { direction: e.target.value })}
                          >
                            <option value="single">Single (A → B)</option>
                            <option value="bidirectional">Bidirectional (A ↔ B)</option>
                          </Select>
                        </FormControl>
                        <Button
                          size="sm"
                          colorScheme="red"
                          variant="ghost"
                          onClick={() => removeRelation(i)}
                        >
                          Remove
                        </Button>
                      </SimpleGrid>
                      {isSelfLoop && (
                        <Text fontSize="xs" color="red.600" mt={2}>
                          A zone cannot relate to itself — pick a different To Zone (this row will be dropped on save).
                        </Text>
                      )}
                    </Box>
                  );
                })}
                <Text fontSize="2xs" color="gray.600">
                  <strong>adjacent / nearby / connected</strong> permit cross-zone correlation in within-zone
                  clustering reports. <strong>contains</strong> marks a parent-child hierarchy.
                  <strong> distant</strong> is an explicit exclusion against spurious spatial-pattern claims.
                </Text>
              </VStack>
            )}
          </CardBody>
        </Card>
        </ErrorBoundary>


        {/* v4 / Module 11.3.3 — soft-required-fields warning. The 5 listed
            fields aren't strictly required (only Project Name + at least one
            Zone Name are blocking), but skipping them materially degrades
            downstream LLM recommendations. The alert shows what's missing
            and what each gap costs; the save button stays enabled. */}
        {(() => {
          const missing: string[] = [];
          if (!koppenZone) missing.push('Köppen Climate Zone — Stage 1 transferability weighting');
          if (!lczType) missing.push('Local Climate Zone (LCZ) — indicator baseline filtering');
          if (!spaceType) missing.push('Space Type — Stage 4 IOM filtering');
          if (!designBrief.trim()) missing.push('Design Brief — Stage 1 indicator recommendation prompt');
          if (selectedDimensions.length === 0) missing.push('Performance Dimensions — Stage 1 indicator filter');
          if (missing.length === 0) return null;
          return (
            <Alert status="warning" borderRadius="md" alignItems="flex-start">
              <AlertIcon />
              <Box>
                <Text fontWeight="bold" fontSize="sm">
                  Recommended fields are empty (save still allowed)
                </Text>
                <Text fontSize="xs" color="gray.700" mt={1}>
                  These fields aren't strictly required, but leaving them blank
                  materially affects downstream analysis quality:
                </Text>
                <Box as="ul" pl={4} mt={1} fontSize="xs">
                  {missing.map((m, i) => (
                    <Box as="li" key={i} listStyleType="disc">{m}</Box>
                  ))}
                </Box>
              </Box>
            </Alert>
          );
        })()}

        {/* Action Buttons */}
        <HStack justify="space-between">
          <Button variant="outline" onClick={() => navigate('/projects')}>
            Cancel
          </Button>
          <Button colorScheme="blue" size="lg" onClick={handleSave} isLoading={saving}>
            {isEditMode ? 'Save & Continue' : 'Create & Continue'}
          </Button>
        </HStack>
      </VStack>
    </PageShell>
  );
}

export default ProjectWizard;
