import { View } from 'react-native';

type Props = {
  landmarks: any[];
  width: number;
  height: number;
};

export default function SkeletonOverlay(_: Props) {
  return <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />;
}
