"""Recorded model policy for compact CTC OCR; used in train AND export."""
import types
import paddle
import paddle.nn.functional as F


def collector_backbone_forward(self,x):
    x=self.conv1(x);x=self.blocks2(x);x=self.blocks3(x)
    x=self.blocks4(x);x=self.blocks5(x);x=self.blocks6(x)
    # Preserve the pretrained vertical reduction. Width pooling is explicit and
    # identical in training/export; width=1 retains twice the CTC positions.
    return F.avg_pool2d(x,[3,self.collector_pool_width])


def install_policy(pool_width):
    import ppocr.modeling.architectures as architectures
    original=architectures.build_model
    def build(config):
        model=original(config)
        model.backbone.collector_pool_width=pool_width
        model.backbone.forward=types.MethodType(collector_backbone_forward,model.backbone)
        for name,parameter in model.named_parameters():
            parameter.stop_gradient=not name.startswith(('neck.','head.'))
        def fixed_features(layer,inputs):
            layer.backbone.eval()
            for child in layer.sublayers():
                if isinstance(child,(paddle.nn.BatchNorm1D,paddle.nn.BatchNorm2D,paddle.nn.BatchNorm3D,paddle.nn.SyncBatchNorm)):child.eval()
        model.register_forward_pre_hook(fixed_features)
        print('COMPACT POLICY: width pool',pool_width,'frozen backbone/BN; train neck/head',flush=True)
        return model
    architectures.build_model=build
