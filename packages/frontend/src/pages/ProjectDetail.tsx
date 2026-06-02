import { useState, useRef, useCallback, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  Box,
  Heading,
  Button,
  HStack,
  SimpleGrid,
  Card,
  CardHeader,
  CardBody,
  Text,
  Badge,
  Tag,
  Wrap,
  WrapItem,
  Alert,
  AlertIcon,
  Progress,
  Checkbox,
  Select,
  Spinner,
} from '@chakra-ui/react';
import { Upload, FolderUp, MapPin, Trash2 } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../api';
import useAppToast from '../hooks/useAppToast';
import type { UploadedImage } from '../types';
import PageShell from '../components/PageShell';
import EmptyState from '../components/EmptyState';
import { ZoneImageTile, UngroupedImageTile } from '../components/ImageTile';
import { ErrorBoundary } from '../components/ErrorBoundary';

function ProjectDetail() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const toast = useAppToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [selectedImageIds, setSelectedImageIds] = useState<Set<string>>(new Set());
  const [targetZoneId, setTargetZoneId] = useState('');
  const [gpsFilter, setGpsFilter] = useState<'all' | 'has' | 'missing'>('all');
  const [batchAssigning, setBatchAssigning] = useState(false);
  const [zoneUploading, setZoneUploading] = useState<string | null>(null);
  const [zoneUploadProgress, setZoneUploadProgress] = useState(0);
  const [reparsingGps, setReparsingGps] = useState(false);
  const zoneFileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const lastClickedIndex = useRef<number>(-1);

  // Pagination for large image sets
  const ZONE_PAGE_SIZE = 48;
  const UNGROUPED_PAGE_SIZE = 100;
  const [zoneVisibleCount, setZoneVisibleCount] = useState<Record<string, number>>({});
  const [ungroupedVisibleCount, setUngroupedVisibleCount] = useState(UNGROUPED_PAGE_SIZE);

  const { data: project, isLoading, error } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.projects.get(projectId!).then(res => res.data),
    enabled: !!projectId,
  });

  // currentProject sync + clearPipelineResults moved to ProjectPipelineLayout so it fires
  // on every /projects/:id/* route, not just ProjectDetail.

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !projectId) return;

    setUploading(true);
    setUploadProgress(0);

    try {
      const fileArray = Array.from(files);
      const chunkSize = 10;
      let uploaded = 0;

      for (let i = 0; i < fileArray.length; i += chunkSize) {
        const chunk = fileArray.slice(i, i + chunkSize);
        await api.projects.uploadImages(projectId, chunk);
        uploaded += chunk.length;
        setUploadProgress(Math.round((uploaded / fileArray.length) * 100));
      }

      toast({ title: `${fileArray.length} image(s) uploaded`, status: 'success' });
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    } catch {
      toast({ title: 'Failed to upload images', status: 'error' });
    }

    setUploading(false);
    setUploadProgress(0);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleFolderSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !projectId || !project) return;

    const zones = project.spatial_zones;
    const fileArray = Array.from(files).filter(f => /\.(jpe?g|png|webp|bmp|tiff?)$/i.test(f.name));
    if (fileArray.length === 0) {
      toast({ title: 'No image files found in folder', status: 'warning' });
      return;
    }

    // Group files by their immediate subfolder name
    // webkitRelativePath = "rootFolder/subfolder/file.jpg" or "rootFolder/file.jpg"
    const grouped = new Map<string, File[]>(); // zone_id → files
    const ungroupedFiles: File[] = [];

    for (const file of fileArray) {
      const parts = file.webkitRelativePath.split('/');
      // parts: [rootFolder, ...subfolders, filename]
      // Use the first subfolder (parts[1]) if it's not the filename itself
      const folderName = parts.length > 2 ? parts[1] : null;

      if (folderName) {
        // Try to match folder name to a zone (case-insensitive)
        const folderLower = folderName.toLowerCase();
        const matchedZone = zones.find(z => {
          const zl = z.zone_name.toLowerCase();
          return zl === folderLower
            || zl.replace(/\s+/g, '_') === folderLower
            || zl.replace(/\s+/g, '-') === folderLower
            || z.zone_id.toLowerCase() === folderLower;
        });
        if (matchedZone) {
          const list = grouped.get(matchedZone.zone_id) || [];
          list.push(file);
          grouped.set(matchedZone.zone_id, list);
        } else {
          ungroupedFiles.push(file);
        }
      } else {
        ungroupedFiles.push(file);
      }
    }

    setUploading(true);
    setUploadProgress(0);
    let totalUploaded = 0;
    const totalFiles = fileArray.length;

    try {
      // Upload zone-matched files with zone_id
      for (const [zoneId, zoneFiles] of grouped) {
        const chunkSize = 10;
        for (let i = 0; i < zoneFiles.length; i += chunkSize) {
          const chunk = zoneFiles.slice(i, i + chunkSize);
          await api.projects.uploadImages(projectId, chunk, zoneId);
          totalUploaded += chunk.length;
          setUploadProgress(Math.round((totalUploaded / totalFiles) * 100));
        }
      }

      // Upload unmatched files without zone_id
      if (ungroupedFiles.length > 0) {
        const chunkSize = 10;
        for (let i = 0; i < ungroupedFiles.length; i += chunkSize) {
          const chunk = ungroupedFiles.slice(i, i + chunkSize);
          await api.projects.uploadImages(projectId, chunk);
          totalUploaded += chunk.length;
          setUploadProgress(Math.round((totalUploaded / totalFiles) * 100));
        }
      }

      const assignedCount = totalFiles - ungroupedFiles.length;
      const zoneCounts = Array.from(grouped.entries())
        .map(([zid, fs]) => {
          const zname = zones.find(z => z.zone_id === zid)?.zone_name || zid;
          return `${zname}: ${fs.length}`;
        }).join(', ');

      if (assignedCount > 0 && ungroupedFiles.length > 0) {
        toast({
          title: `${totalFiles} images uploaded — ${assignedCount} auto-assigned`,
          description: `${zoneCounts}. ${ungroupedFiles.length} unmatched (ungrouped).`,
          status: 'success',
          duration: 6000,
        });
      } else if (assignedCount > 0) {
        toast({
          title: `${totalFiles} images uploaded & auto-assigned`,
          description: zoneCounts,
          status: 'success',
          duration: 5000,
        });
      } else {
        toast({
          title: `${totalFiles} images uploaded (no folder-zone matches)`,
          description: 'Subfolder names did not match any zone names. Assign manually.',
          status: 'info',
          duration: 5000,
        });
      }

      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    } catch {
      toast({ title: 'Failed to upload folder', status: 'error' });
    }

    setUploading(false);
    setUploadProgress(0);
    if (folderInputRef.current) folderInputRef.current.value = '';
  };

  const handleBatchAssign = async () => {
    if (!targetZoneId || selectedImageIds.size === 0) return;
    setBatchAssigning(true);
    try {
      const assignments = Array.from(selectedImageIds).map(imageId => ({
        image_id: imageId,
        zone_id: targetZoneId,
      }));
      await api.projects.batchAssignZones(projectId!, assignments);
      const count = selectedImageIds.size;
      setSelectedImageIds(new Set());
      setTargetZoneId('');
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      toast({ title: `${count} image(s) assigned`, status: 'success' });
    } catch {
      toast({ title: 'Failed to assign images', status: 'error' });
    } finally {
      setBatchAssigning(false);
    }
  };

  // Auto-commit pending batch assignment before navigating to Prepare.
  // Prevents the "I selected images + zone but clicked Next without
  // hitting Assign" UX trap: previously the navigation happened
  // immediately and the pending selection was silently discarded, so the
  // user landed on Prepare with the old (un-updated) zone counts and
  // assumed the assignment had failed. We treat "selection + target
  // zone" as intent to assign — commit it, then navigate. If there's no
  // pending selection, navigate straight away.
  const goToPrepare = async () => {
    if (!projectId) return;
    const hasPendingAssignment = !!targetZoneId && selectedImageIds.size > 0;
    if (hasPendingAssignment) {
      // Reuse the proven assignment helper rather than duplicate the
      // try/catch + invalidation logic. handleBatchAssign clears the
      // selection on success and toasts on both outcomes.
      await handleBatchAssign();
    }
    navigate(`/projects/${projectId}/vision`);
  };

  const handleReparseGps = async () => {
    if (!projectId) return;
    setReparsingGps(true);
    try {
      const { data } = await api.projects.reparseGps(projectId);
      if (data.updated_from_filename > 0) {
        toast({
          title: `GPS extracted from ${data.updated_from_filename} filename(s)`,
          description: data.still_no_gps > 0 ? `${data.still_no_gps} images still have no GPS` : undefined,
          status: 'success',
        });
        queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      } else {
        toast({ title: 'No new GPS coordinates found in filenames', status: 'info' });
      }
    } catch {
      toast({ title: 'Failed to parse GPS from filenames', status: 'error' });
    } finally {
      setReparsingGps(false);
    }
  };

  const handleUnassign = useCallback(async (imageId: string) => {
    try {
      await api.projects.assignImageZone(projectId!, imageId, null);
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      toast({ title: 'Image unassigned', status: 'success' });
    } catch {
      toast({ title: 'Failed to unassign image', status: 'error' });
    }
  }, [projectId, queryClient, toast]);

  const handleZoneUpload = async (zoneId: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !projectId) return;

    setZoneUploading(zoneId);
    setZoneUploadProgress(0);

    try {
      const fileArray = Array.from(files);
      const chunkSize = 10;
      let uploaded = 0;

      for (let i = 0; i < fileArray.length; i += chunkSize) {
        const chunk = fileArray.slice(i, i + chunkSize);
        await api.projects.uploadImages(projectId, chunk, zoneId);
        uploaded += chunk.length;
        setZoneUploadProgress(Math.round((uploaded / fileArray.length) * 100));
      }

      toast({ title: `${fileArray.length} image(s) uploaded to zone`, status: 'success' });
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    } catch {
      toast({ title: 'Failed to upload images', status: 'error' });
    }

    setZoneUploading(null);
    setZoneUploadProgress(0);
    const ref = zoneFileInputRefs.current[zoneId];
    if (ref) ref.value = '';
  };

  const matchesGpsFilter = useCallback((img: UploadedImage) => {
    if (gpsFilter === 'all') return true;
    if (gpsFilter === 'has') return !!img.has_gps;
    return !img.has_gps;
  }, [gpsFilter]);

  const handleImageClick = useCallback((imageId: string, index: number, e: React.MouseEvent) => {
    const ungrouped = (project?.uploaded_images?.filter(img => !img.zone_id) || []).filter(matchesGpsFilter);

    if (e.shiftKey && lastClickedIndex.current >= 0) {
      const start = Math.min(lastClickedIndex.current, index);
      const end = Math.max(lastClickedIndex.current, index);
      setSelectedImageIds(prev => {
        const next = new Set(prev);
        for (let i = start; i <= end; i++) {
          next.add(ungrouped[i].image_id);
        }
        return next;
      });
    } else {
      setSelectedImageIds(prev => {
        const next = new Set(prev);
        if (next.has(imageId)) next.delete(imageId);
        else next.add(imageId);
        return next;
      });
    }
    lastClickedIndex.current = index;
  }, [project?.uploaded_images, matchesGpsFilter]);

  const deleteImageMutation = useMutation({
    mutationFn: (imageId: string) => api.projects.deleteImage(projectId!, imageId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      toast({ title: 'Image deleted', status: 'success' });
    },
  });

  const batchDeleteMutation = useMutation({
    mutationFn: (imageIds: string[]) => api.projects.batchDeleteImages(projectId!, imageIds),
    onSuccess: (res) => {
      const count = res.data.deleted;
      setSelectedImageIds(new Set());
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      toast({ title: `${count} image(s) deleted`, status: 'success' });
    },
    onError: () => {
      toast({ title: 'Failed to delete images', status: 'error' });
    },
  });

  const handleDeleteImage = useCallback(
    (imageId: string) => deleteImageMutation.mutate(imageId),
    [deleteImageMutation],
  );

  const handleBatchDelete = () => {
    if (selectedImageIds.size === 0) return;
    const count = selectedImageIds.size;
    if (!window.confirm(`Delete ${count} image(s)? This cannot be undone.`)) return;
    batchDeleteMutation.mutate(Array.from(selectedImageIds));
  };

  // All hooks MUST be above early returns (Rules of Hooks)
  const images = project?.uploaded_images ?? [];
  const ungroupedImages = useMemo(
    () => images.filter(img => !img.zone_id),
    [images],
  );
  const visibleUngrouped = useMemo(
    () => ungroupedImages.filter(matchesGpsFilter),
    [ungroupedImages, matchesGpsFilter],
  );
  const zoneImagesMap = useMemo(() => {
    const map: Record<string, UploadedImage[]> = {};
    for (const img of images) {
      if (img.zone_id) {
        (map[img.zone_id] ||= []).push(img);
      }
    }
    return map;
  }, [images]);

  const assignedCount = useMemo(() => images.filter(i => i.zone_id).length, [images]);
  const gpsCount = useMemo(() => images.filter(i => i.has_gps).length, [images]);
  const ungroupedGpsCount = useMemo(() => ungroupedImages.filter(i => i.has_gps).length, [ungroupedImages]);

  if (isLoading) {
    return <PageShell isLoading loadingText="Loading project..." />;
  }

  if (error || !project) {
    return (
      <PageShell>
        <Alert status="error">
          <AlertIcon />
          Project not found
        </Alert>
        <Button mt={4} onClick={() => navigate('/projects')}>
          Back to Projects
        </Button>
      </PageShell>
    );
  }

  const hasZones = project.spatial_zones.length > 0;
  const hasImages = images.length > 0;
  const isReady = hasZones && hasImages && assignedCount > 0;

  return (
    <PageShell>
      {/* Header */}
      <HStack justify="space-between" mb={4}>
        <Box>
          <Heading size="lg">{project.project_name}</Heading>
          <Text color="gray.500" fontSize="sm" mt={1}>
            {project.project_location || 'No location'} &bull; {project.site_scale || 'No scale'}
            {project.koppen_zone_id && ` \u2022 ${project.koppen_zone_id}`}
          </Text>
        </Box>
        <Button variant="outline" size="sm" as={Link} to={`/projects/${projectId}/edit`}>
          Edit Project
        </Button>
      </HStack>

      {/* Compact summary */}
      <HStack spacing={6} mb={4} px={1}>
        <HStack spacing={1}>
          <Text fontSize="sm" color="gray.500">Zones:</Text>
          <Badge colorScheme={hasZones ? 'blue' : 'red'}>{project.spatial_zones.length}</Badge>
        </HStack>
        <HStack spacing={1}>
          <Text fontSize="sm" color="gray.500">Images:</Text>
          <Badge colorScheme={hasImages ? 'green' : 'gray'}>{project.uploaded_images?.length ?? 0}</Badge>
        </HStack>
        <HStack spacing={1}>
          <Text fontSize="sm" color="gray.500">Assigned:</Text>
          <Badge colorScheme={assignedCount > 0 ? 'purple' : 'gray'}>{assignedCount}</Badge>
        </HStack>
        {hasImages && (
          <HStack spacing={1} title="Images with GPS coordinates (EXIF or filename)">
            <MapPin size={12} color="#319795" />
            <Badge colorScheme={gpsCount > 0 ? 'teal' : 'gray'}>{gpsCount}/{project.uploaded_images?.length ?? 0}</Badge>
          </HStack>
        )}
        {project.performance_dimensions.length > 0 && (
          <Wrap spacing={1}>
            {project.performance_dimensions.slice(0, 3).map(dim => (
              <WrapItem key={dim}><Tag size="sm" colorScheme="blue">{dim}</Tag></WrapItem>
            ))}
            {project.performance_dimensions.length > 3 && (
              <WrapItem><Tag size="sm">+{project.performance_dimensions.length - 3}</Tag></WrapItem>
            )}
          </Wrap>
        )}
      </HStack>

      {/* Guidance alerts */}
      {!hasZones && (
        <Alert status="warning" mb={4} borderRadius="md">
          <AlertIcon />
          <Text fontSize="sm">
            No zones defined.{' '}
            <Button as={Link} to={`/projects/${projectId}/edit`} variant="link" colorScheme="orange" size="sm">
              Edit project
            </Button>
            {' '}to add spatial zones first.
          </Text>
        </Alert>
      )}

      {hasImages && gpsCount < images.length && (
        <Alert status="info" mb={4} borderRadius="md">
          <AlertIcon />
          <Box flex={1}>
            <Text fontSize="sm">
              {gpsCount === 0
                ? `${images.length} images have no GPS coordinates.`
                : `${images.length - gpsCount} of ${images.length} images are missing GPS coordinates.`
              }
              {' '}If your filenames contain coordinates (e.g. <code>0.0.120.125.30.254...</code>), you can extract them automatically.
            </Text>
          </Box>
          <Button
            size="sm"
            colorScheme="teal"
            variant="solid"
            ml={3}
            isLoading={reparsingGps}
            loadingText="Parsing..."
            onClick={handleReparseGps}
            flexShrink={0}
          >
            <MapPin size={14} style={{ marginRight: 6 }} />
            Extract GPS from filenames
          </Button>
        </Alert>
      )}

      {/* Upload progress */}
      {uploading && (
        <Card mb={4}>
          <CardBody>
            <Box p={4} textAlign="center">
              <Spinner size="sm" mr={2} />
              <Text as="span" fontSize="sm">Uploading... {uploadProgress}%</Text>
              <Progress value={uploadProgress} mt={2} size="sm" colorScheme="green" borderRadius="full" />
            </Box>
          </CardBody>
        </Card>
      )}

      {/* Bulk Upload */}
      {/* v4.x — ErrorBoundary around the upload card so a crash in file
          handling / drag-drop logic doesn't take out the image grids
          below it. */}
      {!uploading && hasZones && (
        <ErrorBoundary label="Bulk Upload card">
        <Card mb={4}>
          <CardBody py={3}>
            <HStack spacing={4}>
              <Box
                flex={1}
                p={3}
                border="2px dashed"
                borderColor="gray.200"
                borderRadius="lg"
                textAlign="center"
                cursor="pointer"
                bg="gray.50"
                _hover={{ borderColor: 'gray.400', bg: 'gray.100' }}
                transition="all 0.2s ease"
                onClick={() => fileInputRef.current?.click()}
              >
                <HStack justify="center" spacing={2}>
                  <Upload size={18} />
                  <Text fontWeight="bold" fontSize="sm">Upload Files</Text>
                </HStack>
                <Text fontSize="xs" color="gray.500">Upload to ungrouped, assign later</Text>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={handleFileSelect}
                />
              </Box>
              <Box
                flex={1}
                p={3}
                border="2px dashed"
                borderColor="purple.200"
                borderRadius="lg"
                textAlign="center"
                cursor="pointer"
                bg="purple.50"
                _hover={{ borderColor: 'purple.400', bg: 'purple.100' }}
                transition="all 0.2s ease"
                onClick={() => folderInputRef.current?.click()}
              >
                <HStack justify="center" spacing={2}>
                  <FolderUp size={18} />
                  <Text fontWeight="bold" fontSize="sm">Upload Folder</Text>
                </HStack>
                <Text fontSize="xs" color="gray.500">Auto-assign by subfolder name</Text>
                <input
                  ref={folderInputRef}
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={handleFolderSelect}
                  {...{ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>}
                />
              </Box>
            </HStack>
            <Box mt={3} px={1}>
              <Text fontSize="xs" color="gray.500" lineHeight="tall">
                <strong>Folder upload</strong>: Organize images in subfolders named after your zones.
                Matching is case-insensitive, spaces can be underscores or hyphens
                (e.g., zone "Park Entrance" matches folder <code>park_entrance</code> or <code>Park-Entrance</code>).
                Unmatched subfolders go to Ungrouped.
              </Text>
              <Text fontSize="xs" color="gray.500" mt={1}>
                <strong>File upload</strong>: Images go to Ungrouped. Use Shift+Click to select a range, then batch-assign to a zone.
              </Text>
              <Text fontSize="xs" color="gray.500" mt={1}>
                <strong>Zone upload</strong>: Click the Upload button on each zone card below to add images directly.
              </Text>
            </Box>
          </CardBody>
        </Card>
        </ErrorBoundary>
      )}

      {/* Zone cards with images */}
      {/* v4.x — Wrap each zone card with its own ErrorBoundary keyed on
          zone_id so one zone's image grid crashing doesn't take out the
          others. ImageTile rendering, virtualized grids, and zone-type
          tags are the crash surfaces here. */}
      {project.spatial_zones.map(zone => {
        const zoneImages = zoneImagesMap[zone.zone_id] || [];
        const isThisZoneUploading = zoneUploading === zone.zone_id;
        return (
          <ErrorBoundary key={zone.zone_id} label={`Zone "${zone.zone_name}" image grid`}>
          <Card key={zone.zone_id} mb={3}>
            <CardHeader py={3}>
              <HStack justify="space-between">
                <HStack spacing={2}>
                  <Heading size="sm">{zone.zone_name}</Heading>
                  <Badge>{zoneImages.length} images</Badge>
                  {zone.zone_types.length > 0 && (
                    <Wrap spacing={1}>
                      {zone.zone_types.slice(0, 2).map(t => (
                        <WrapItem key={t}><Tag size="sm" variant="subtle">{t}</Tag></WrapItem>
                      ))}
                    </Wrap>
                  )}
                </HStack>
                <HStack spacing={2}>
                  {isThisZoneUploading ? (
                    <HStack spacing={2}>
                      <Spinner size="xs" />
                      <Text fontSize="xs" color="gray.500">{zoneUploadProgress}%</Text>
                    </HStack>
                  ) : (
                    <Button
                      size="xs"
                      leftIcon={<Upload size={12} />}
                      variant="outline"
                      onClick={() => zoneFileInputRefs.current[zone.zone_id]?.click()}
                      isDisabled={zoneUploading !== null}
                    >
                      Upload
                    </Button>
                  )}
                  <input
                    ref={(el) => { zoneFileInputRefs.current[zone.zone_id] = el; }}
                    type="file"
                    multiple
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={(e) => handleZoneUpload(zone.zone_id, e)}
                  />
                </HStack>
              </HStack>
            </CardHeader>
            <CardBody pt={0}>
              {zoneImages.length > 0 ? (
                <>
                  <Box maxH="300px" overflowY="auto" borderRadius="md">
                    <SimpleGrid columns={{ base: 4, md: 6, lg: 8 }} spacing={2}>
                      {zoneImages.slice(0, zoneVisibleCount[zone.zone_id] || ZONE_PAGE_SIZE).map(img => (
                        <ZoneImageTile
                          key={img.image_id}
                          projectId={project.id}
                          imageId={img.image_id}
                          hasGps={img.has_gps}
                          latitude={img.latitude}
                          longitude={img.longitude}
                          onUnassign={handleUnassign}
                          onDelete={handleDeleteImage}
                        />
                      ))}
                    </SimpleGrid>
                  </Box>
                  {zoneImages.length > (zoneVisibleCount[zone.zone_id] || ZONE_PAGE_SIZE) && (
                    <Button
                      size="xs"
                      variant="ghost"
                      mt={2}
                      w="full"
                      onClick={() => setZoneVisibleCount(prev => ({
                        ...prev,
                        [zone.zone_id]: (prev[zone.zone_id] || ZONE_PAGE_SIZE) + ZONE_PAGE_SIZE,
                      }))}
                    >
                      Show more ({zoneImages.length - (zoneVisibleCount[zone.zone_id] || ZONE_PAGE_SIZE)} remaining)
                    </Button>
                  )}
                </>
              ) : (
                <Text fontSize="sm" color="gray.400" textAlign="center" py={2}>
                  No images — click Upload to add
                </Text>
              )}
            </CardBody>
          </Card>
          </ErrorBoundary>
        );
      })}

      {/* Empty state */}
      {!hasZones && !hasImages && (
        <EmptyState icon={MapPin} title="No zones defined" description="Edit the project to add spatial zones, then upload images here." />
      )}

      {/* Ungrouped Images */}
      {ungroupedImages.length > 0 && (
        <ErrorBoundary label="Ungrouped Images panel">
        <Card mb={4}>
          <CardHeader py={3}>
            <HStack justify="space-between" flexWrap="wrap" gap={2}>
              <Heading size="sm">
                Ungrouped Images ({gpsFilter === 'all' ? ungroupedImages.length : `${visibleUngrouped.length} of ${ungroupedImages.length}`})
              </Heading>
              <HStack spacing={2}>
                <Text fontSize="xs" color="gray.500">GPS:</Text>
                <Select
                  size="xs"
                  maxW="170px"
                  value={gpsFilter}
                  onChange={(e) => {
                    setGpsFilter(e.target.value as 'all' | 'has' | 'missing');
                    setSelectedImageIds(new Set());
                    lastClickedIndex.current = -1;
                  }}
                >
                  <option value="all">All ({ungroupedImages.length})</option>
                  <option value="has">Has GPS ({ungroupedGpsCount})</option>
                  <option value="missing">Missing GPS ({ungroupedImages.length - ungroupedGpsCount})</option>
                </Select>
              </HStack>
            </HStack>
          </CardHeader>
          <CardBody pt={0}>
            {hasZones && (
              <HStack spacing={3} flexWrap="wrap" mb={3}>
                <Checkbox
                  isChecked={selectedImageIds.size === visibleUngrouped.length && visibleUngrouped.length > 0}
                  isIndeterminate={selectedImageIds.size > 0 && selectedImageIds.size < visibleUngrouped.length}
                  isDisabled={visibleUngrouped.length === 0}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setSelectedImageIds(new Set(visibleUngrouped.map(img => img.image_id)));
                    } else {
                      setSelectedImageIds(new Set());
                    }
                  }}
                >
                  Select All
                </Checkbox>
                <Select
                  placeholder="Select zone..."
                  size="sm"
                  maxW="200px"
                  value={targetZoneId}
                  onChange={(e) => setTargetZoneId(e.target.value)}
                >
                  {project.spatial_zones.map(zone => (
                    <option key={zone.zone_id} value={zone.zone_id}>
                      {zone.zone_name}
                    </option>
                  ))}
                </Select>
                <Button
                  size="sm"
                  colorScheme="blue"
                  isDisabled={!targetZoneId || selectedImageIds.size === 0}
                  isLoading={batchAssigning}
                  onClick={handleBatchAssign}
                >
                  Assign ({selectedImageIds.size})
                </Button>
                <Button
                  size="sm"
                  colorScheme="red"
                  variant="outline"
                  leftIcon={<Trash2 size={14} />}
                  isDisabled={selectedImageIds.size === 0}
                  isLoading={batchDeleteMutation.isPending}
                  onClick={handleBatchDelete}
                >
                  Delete ({selectedImageIds.size})
                </Button>
              </HStack>
            )}
            {visibleUngrouped.length > 16 && (
              <Text fontSize="xs" color="gray.400" mb={1}>
                Tip: Click to select, Shift+Click to select a range
              </Text>
            )}
            {visibleUngrouped.length === 0 && ungroupedImages.length > 0 && (
              <Text fontSize="sm" color="gray.400" textAlign="center" py={4}>
                No images match the current GPS filter
              </Text>
            )}
            <Box maxH="400px" overflowY="auto" borderRadius="md">
              <SimpleGrid columns={{ base: 4, md: 6, lg: 8 }} spacing={2}>
                {visibleUngrouped.slice(0, ungroupedVisibleCount).map((img, idx) => (
                  <UngroupedImageTile
                    key={img.image_id}
                    projectId={project.id}
                    imageId={img.image_id}
                    index={idx}
                    selected={selectedImageIds.has(img.image_id)}
                    hasGps={img.has_gps}
                    latitude={img.latitude}
                    longitude={img.longitude}
                    showCheckbox={hasZones}
                    onClick={handleImageClick}
                    onDelete={handleDeleteImage}
                  />
                ))}
              </SimpleGrid>
            </Box>
            {visibleUngrouped.length > ungroupedVisibleCount && (
              <Button
                size="sm"
                variant="ghost"
                mt={2}
                w="full"
                onClick={() => setUngroupedVisibleCount(prev => prev + UNGROUPED_PAGE_SIZE)}
              >
                Show more ({visibleUngrouped.length - ungroupedVisibleCount} remaining)
              </Button>
            )}
          </CardBody>
        </Card>
        </ErrorBoundary>
      )}

      {/* Navigation */}
      <HStack justify="space-between" mt={6}>
        <Button as={Link} to={`/projects/${projectId}/edit`} variant="outline">
          Back: Project
        </Button>
        <Button
          colorScheme="blue"
          isDisabled={!isReady}
          isLoading={batchAssigning}
          onClick={goToPrepare}
        >
          Next: Prepare
        </Button>
      </HStack>
      {!isReady && hasZones && (
        <Text fontSize="xs" color="gray.400" textAlign="right" mt={1}>
          Upload images and assign to zones to continue
        </Text>
      )}
      {!!targetZoneId && selectedImageIds.size > 0 && (
        <Text fontSize="xs" color="blue.500" textAlign="right" mt={1}>
          {selectedImageIds.size} pending assignment{selectedImageIds.size === 1 ? '' : 's'}
          {' '}— will be saved when you click Next.
        </Text>
      )}
    </PageShell>
  );
}

export default ProjectDetail;
