"""Teach verified no-text crops with genuine length-zero CTC targets."""
import numpy as np
import paddle
import paddle.nn.functional as F


class CollectorBlankCTCLoss(paddle.nn.Layer):
    """Exact CTC, with analytic all-blank paths instead of warpCTC's zero-label bug."""
    def __init__(self,**kwargs):
        super().__init__();self.ctc=paddle.nn.CTCLoss(blank=0,reduction='none')

    def forward(self,predicts,batch):
        if isinstance(predicts,(list,tuple)):predicts=predicts[-1]
        logits=predicts.astype('float32');lengths=batch[2].astype('int64')
        positive=paddle.nonzero(lengths>0).flatten();negative=(lengths==0).astype('float32')
        # Empty target has exactly one valid CTC path: blank at every timestep.
        # Native GPU warpCTC crashes when the entire batch has zero labels.
        loss=(-F.log_softmax(logits,axis=-1)[:,:,0].sum(axis=1)*negative).sum()
        if positive.shape[0]:
            selected=paddle.index_select(logits,positive,axis=0)
            labels=paddle.index_select(batch[1].astype('int32'),positive,axis=0)
            target_lengths=paddle.index_select(lengths,positive,axis=0)
            input_lengths=paddle.to_tensor([selected.shape[1]]*selected.shape[0],dtype='int64',place=paddle.CPUPlace())
            loss=loss+self.ctc(selected.transpose((1,0,2)),labels,input_lengths,target_lengths).sum()
        return {'loss':loss/logits.shape[0]}


def install_negative_encoder():
    import ppocr.data.imaug as imaug
    from ppocr.data.imaug.label_ops import CTCLabelEncode

    class CollectorCTCLabelEncode(CTCLabelEncode):
        def __call__(self,data):
            if data['label']!='':return super().__call__(data)
            # Empty target is NOT a space token: CTC must emit blank at every
            # timestep. Native Paddle CTC supports length zero on CPU and GPU.
            data['length']=np.array(0,dtype=np.int64)
            data['label']=np.zeros(self.max_text_len,dtype=np.int64)
            data['label_ace']=np.zeros(len(self.character),dtype=np.int64)
            return data

    imaug.CollectorCTCLabelEncode=CollectorCTCLabelEncode
    import ppocr.losses as losses
    original=losses.build_loss
    def build(config):
        if config['name']=='CollectorBlankCTCLoss':return CollectorBlankCTCLoss()
        return original(config)
    losses.build_loss=build

