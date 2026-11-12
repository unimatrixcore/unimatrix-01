"""Preserve twice as many horizontal CTC positions for narrow name glyphs.

Only the second stem convolution's horizontal stride changes from2 to1.
Weights and vertical geometry are preserved. Train and export must both install
this policy; numerical export parity must verify the resulting width/2 output.
"""


def install_name_resolution():
    import ppocr.modeling.architectures as architectures
    original=architectures.build_model
    def build(config):
        model=original(config)
        convolution=model.backbone.conv1.stem3.conv
        assert list(convolution._stride)==[2,2],convolution._stride
        convolution._stride=[2,1]
        print('NAME RESOLUTION: stem3 stride=(2,1); output temporal stride2; unchanged weights',flush=True)
        return model
    architectures.build_model=build
