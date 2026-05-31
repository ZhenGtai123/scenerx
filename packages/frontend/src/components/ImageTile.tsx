import { memo, useRef, useState, useEffect } from 'react';
import { Box, IconButton, Checkbox } from '@chakra-ui/react';
import { X, Undo2, MapPin } from 'lucide-react';

/* ------------------------------------------------------------------ */
/*  Thumbnail URL builder                                              */
/* ------------------------------------------------------------------ */

// eslint-disable-next-line react-refresh/only-export-components -- Co-located with ZoneTile because the URL shape is part of the tile's contract; splitting to a separate file would obscure that.
export function thumbnailUrl(projectId: string, imageId: string, size = 160): string {
  return `/api/projects/${projectId}/images/${imageId}/thumbnail?size=${size}`;
}

/* ------------------------------------------------------------------ */
/*  Zone image tile (hover buttons: unassign + delete)                 */
/* ------------------------------------------------------------------ */

interface ZoneTileProps {
  projectId: string;
  imageId: string;
  hasGps: boolean;
  latitude?: number | null;
  longitude?: number | null;
  onUnassign: (imageId: string) => void;
  onDelete: (imageId: string) => void;
}

export const ZoneImageTile = memo(function ZoneImageTile({
  projectId,
  imageId,
  hasGps,
  latitude,
  longitude,
  onUnassign,
  onDelete,
}: ZoneTileProps) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <Box ref={sentinelRef} position="relative" role="group">
      <Box
        h="80px"
        w="100%"
        borderRadius="md"
        bg="gray.200"
        backgroundImage={visible ? `url(${thumbnailUrl(projectId, imageId)})` : undefined}
        backgroundSize="cover"
        backgroundPosition="center"
      />
      <IconButton
        aria-label="Unassign from zone"
        icon={<Undo2 size={12} />}
        size="xs"
        position="absolute"
        top={1}
        left={1}
        colorScheme="yellow"
        title="Move back to ungrouped"
        opacity={0}
        _groupHover={{ opacity: 1 }}
        onClick={() => onUnassign(imageId)}
      />
      <IconButton
        aria-label="Delete"
        icon={<X size={12} />}
        size="xs"
        position="absolute"
        top={1}
        right={1}
        colorScheme="red"
        opacity={0}
        _groupHover={{ opacity: 1 }}
        onClick={() => onDelete(imageId)}
      />
      {hasGps && (
        <Box
          position="absolute"
          bottom={1}
          left={1}
          bg="teal.500"
          color="white"
          borderRadius="sm"
          p="2px"
          title={`GPS: ${latitude?.toFixed(4)}, ${longitude?.toFixed(4)}`}
          pointerEvents="none"
        >
          <MapPin size={10} />
        </Box>
      )}
    </Box>
  );
});

/* ------------------------------------------------------------------ */
/*  Ungrouped image tile (selection + delete)                          */
/* ------------------------------------------------------------------ */

interface UngroupedTileProps {
  projectId: string;
  imageId: string;
  index: number;
  selected: boolean;
  hasGps: boolean;
  latitude?: number | null;
  longitude?: number | null;
  showCheckbox: boolean;
  onClick: (imageId: string, index: number, e: React.MouseEvent) => void;
  onDelete: (imageId: string) => void;
}

export const UngroupedImageTile = memo(function UngroupedImageTile({
  projectId,
  imageId,
  index,
  selected,
  hasGps,
  latitude,
  longitude,
  showCheckbox,
  onClick,
  onDelete,
}: UngroupedTileProps) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <Box ref={sentinelRef} position="relative" role="group">
      <Box
        h="80px"
        w="100%"
        borderRadius="md"
        bg="gray.200"
        cursor="pointer"
        border="2px solid"
        borderColor={selected ? 'blue.400' : 'transparent'}
        backgroundImage={visible ? `url(${thumbnailUrl(projectId, imageId)})` : undefined}
        backgroundSize="cover"
        backgroundPosition="center"
        onClick={(e) => onClick(imageId, index, e)}
      />
      {showCheckbox && (
        <Checkbox
          position="absolute"
          top={1}
          left={1}
          bg="whiteAlpha.800"
          borderRadius="sm"
          isChecked={selected}
          onChange={(e) => onClick(imageId, index, e as unknown as React.MouseEvent)}
        />
      )}
      {hasGps && (
        <Box
          position="absolute"
          bottom={1}
          left={1}
          bg="teal.500"
          color="white"
          borderRadius="sm"
          p="2px"
          title={`GPS: ${latitude?.toFixed(4)}, ${longitude?.toFixed(4)}`}
          pointerEvents="none"
        >
          <MapPin size={10} />
        </Box>
      )}
      <IconButton
        aria-label="Delete"
        icon={<X size={12} />}
        size="xs"
        position="absolute"
        top={1}
        right={1}
        colorScheme="red"
        opacity={0}
        _groupHover={{ opacity: 1 }}
        onClick={(e) => { e.stopPropagation(); onDelete(imageId); }}
      />
    </Box>
  );
});
