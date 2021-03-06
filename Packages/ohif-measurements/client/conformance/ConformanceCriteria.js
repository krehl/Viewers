import { ReactiveVar } from 'meteor/reactive-var';
import { Tracker } from 'meteor/tracker';
import { Session } from 'meteor/session';
import { _ } from 'meteor/underscore';
import { OHIF } from 'meteor/ohif:core';
import 'meteor/ohif:viewerbase';
import { CriteriaEvaluator } from './CriteriaEvaluator';
import * as evaluations from './evaluations';

class ConformanceCriteria {

    constructor(measurementApi, timepointApi) {
        this.measurementApi = measurementApi;
        this.timepointApi = timepointApi;
        this.nonconformities = new ReactiveVar();
        this.groupedNonConformities = new ReactiveVar();
        this.maxTargets = new ReactiveVar(null);

        const validate = _.debounce(trialCriteriaType => {
            if (!Session.get('MeasurementsReady')) return;
            this.validate(trialCriteriaType);
        }, 300);

        Tracker.autorun(() => {
            const selectedType = OHIF.lesiontracker.TrialCriteriaTypes.findOne({ selected: true });
            this.measurementApi.changeObserver.depend();
            validate(selectedType);
        });
    }

    validate(trialCriteriaType) {
        return new Promise((resolve, reject) => {
            const baselinePromise = this.getData('baseline');
            const followupPromise = this.getData('followup');
            Promise.all([baselinePromise, followupPromise]).then(values => {
                const [baselineData, followupData] = values;
                const mergedData = {
                    targets: [],
                    nonTargets: []
                };

                mergedData.targets = mergedData.targets.concat(baselineData.targets);
                mergedData.targets = mergedData.targets.concat(followupData.targets);
                mergedData.nonTargets = mergedData.nonTargets.concat(baselineData.nonTargets);
                mergedData.nonTargets = mergedData.nonTargets.concat(followupData.nonTargets);

                this.maxTargets.set(null);
                const resultBoth = this.validateTimepoint('both', trialCriteriaType, mergedData);
                const resultBaseline = this.validateTimepoint('baseline', trialCriteriaType, baselineData);
                const resultFollowup = this.validateTimepoint('followup', trialCriteriaType, followupData);
                const nonconformities = resultBaseline.concat(resultFollowup).concat(resultBoth);
                const groupedNonConformities = this.groupNonConformities(nonconformities);

                // Keep both? Group the data only on viewer/measurementTable views?
                // Work with not grouped data (worse lookup performance on measurementTableRow)?
                this.nonconformities.set(nonconformities);
                this.groupedNonConformities.set(groupedNonConformities);

                resolve(nonconformities);
            });
        });
    }

    groupNonConformities(nonconformities) {
        const groups = {};
        const toolsGroupsMap = this.measurementApi.toolsGroupsMap;

        nonconformities.forEach(nonConformity => {
            if (nonConformity.isGlobal) {
                groups.globals = groups.globals || { messages: [] };
                groups.globals.messages.push(nonConformity.message);

                return;
            }

            nonConformity.measurements.forEach(measurement => {
                const groupName = toolsGroupsMap[measurement.toolType];
                groups[groupName] = groups[groupName] || { measurementNumbers: {} };

                const group = groups[groupName];
                const measureNumber = measurement.measurementNumber;
                let measurementNumbers = group.measurementNumbers[measureNumber];

                if (!measurementNumbers) {
                    measurementNumbers = group.measurementNumbers[measureNumber] = {
                        messages: [],
                        measurements: []
                    };
                }

                measurementNumbers.messages.push(nonConformity.message);
                measurementNumbers.measurements.push(measurement);
            });
        });

        return groups;
    }

    validateTimepoint(timepointId, trialCriteriaType, data) {
        const evaluators = this.getEvaluators(timepointId, trialCriteriaType);
        let nonconformities = [];

        evaluators.forEach(evaluator => {
            const maxTargets = evaluator.getMaxTargets();
            if (maxTargets) {
                this.maxTargets.set(maxTargets);
            }

            const result = evaluator.evaluate(data);
            nonconformities = nonconformities.concat(result);
        });

        return nonconformities;
    }

    getEvaluators(timepointId, trialCriteriaType) {
        const evaluators = [];
        const trialCriteriaTypeId = trialCriteriaType.id.toLowerCase();
        const evaluation = evaluations[trialCriteriaTypeId];

        if (evaluation) {
            const evaluationTimepoint = evaluation[timepointId];

            if (evaluationTimepoint) {
                evaluators.push(new CriteriaEvaluator(evaluationTimepoint));
            }
        }

        return evaluators;
    }

    /*
     * Build the data that will be used to do the conformance criteria checks
     */
    getData(timepointType) {
        return new Promise((resolve, reject) => {
            const data = {
                targets: [],
                nonTargets: []
            };

            const studyPromises = [];

            const fillData = measurementType => {
                const measurements = this.measurementApi.fetch(measurementType);

                measurements.forEach(measurement => {
                    const { studyInstanceUid } = measurement;

                    const timepointId = measurement.timepointId;
                    const timepoint = timepointId && this.timepointApi.timepoints.findOne({ timepointId });

                    if (!timepoint || ((timepointType !== 'both') && (timepoint.timepointType !== timepointType))) {
                        return;
                    }

                    const promise = OHIF.studylist.retrieveStudyMetadata(studyInstanceUid);
                    promise.then(study => {
                        let studyMetadata = study;
                        if (!(study instanceof OHIF.viewerbase.metadata.StudyMetadata)) {
                            studyMetadata = new OHIF.metadata.StudyMetadata(study, study.studyInstanceUid);
                        }

                        data[measurementType].push({
                            measurement,
                            metadata: studyMetadata.getFirstInstance(),
                            timepoint
                        });
                    });
                    studyPromises.push(promise);
                });
            };

            fillData('targets');
            fillData('nonTargets');

            Promise.all(studyPromises).then(() => {
                resolve(data);
            }).catch(reject);
        });
    }

    static setEvaluationDefinitions(evaluationKey, evaluationDefinitions) {
        evaluations[evaluationKey] = evaluationDefinitions;
    }

}

OHIF.measurements.ConformanceCriteria = ConformanceCriteria;
